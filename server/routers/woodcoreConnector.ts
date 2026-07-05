/**
 * WoodCore connector tRPC router — config UI + health dashboard.
 *
 * Access model:
 *   - Reads (health, runs, events, DLQ, mappings): any authenticated member of
 *     the organization (the institution's IT admin dashboard).
 *   - Writes (config, mappings, DLQ actions, manual sync): admin or super_admin.
 * All queries are scoped to the caller's organizationId — no cross-tenant reads.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import {
  wcConnectorConfigs,
  wcConnectorDeadLetters,
  wcConnectorFieldMappings,
  wcConnectorSyncRuns,
  wcConnectorWebhookEvents,
} from "../../drizzle/connector_schema";
import { ENV } from "../_core/env";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { dlqHandlers } from "../connectors/woodcore";
import { getCbsProfile, listCbsProfiles } from "../connectors/cbs/registry";
import { importCbsCsv } from "../connectors/cbs/csvImport";
import { getConfigRowByOrg } from "../connectors/woodcore/config";
import { discardDeadLetter, processDueDeadLetters, replayDeadLetter } from "../connectors/woodcore/dlq";
import { getConnectorHealth, testConnection } from "../connectors/woodcore/health";
import {
  applyMapping,
  validateRules,
  type MappingRule,
} from "../connectors/woodcore/mapping";
import { encryptSecret, maskSecret } from "../connectors/woodcore/secrets";
import { runBatchSync } from "../connectors/woodcore/sync";
import { pushWriteBackNote } from "../connectors/woodcore/writeback";

const entitySchema = z.enum(["savings_transaction", "loan_transaction", "journal_entry"]);

/** Admin-or-super-admin gate on top of protectedProcedure. */
const connectorAdminProcedure = protectedProcedure.use(async (opts) => {
  const role = opts.ctx.user.role ?? "";
  if (role !== "admin" && role !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return opts.next();
});

/** Super-admin-only gate (Infinity AI platform operations, e.g. client onboarding). */
const superAdminProcedure = protectedProcedure.use(async (opts) => {
  if ((opts.ctx.user.role ?? "") !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super admin access required" });
  }
  return opts.next();
});

function requireOrgId(user: { organizationId?: number | null }): number {
  if (!user.organizationId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is not linked to an organization",
    });
  }
  return user.organizationId;
}

/**
 * Resolve which organization a call operates on. Super admins may pass an
 * explicit organizationId (portal context / onboarded-client management);
 * everyone else is locked to their own organization.
 */
function resolveOrgId(
  user: { role?: string | null; organizationId?: number | null },
  override?: number,
): number {
  if (override !== undefined) {
    if (user.role !== "super_admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can act on another organization" });
    }
    return override;
  }
  return requireOrgId(user);
}

/** Optional org override accepted by org-scoped procedures (super admins only). */
const orgOverrideInput = z.object({ organizationId: z.number().int().positive().optional() });

async function requireOrgConfig(organizationId: number) {
  const cfg = await getConfigRowByOrg(organizationId);
  if (!cfg) {
    throw new TRPCError({ code: "NOT_FOUND", message: "WoodCore connector is not configured yet" });
  }
  return cfg;
}

/** Never send secrets to the client — masked previews only. */
function toClientConfig(cfg: NonNullable<Awaited<ReturnType<typeof getConfigRowByOrg>>>) {
  const profile = getCbsProfile(cfg.cbsType);
  return {
    id: cfg.id,
    cbsType: profile.type,
    cbsLabel: profile.label,
    cbsVendor: profile.vendor,
    cbsNotes: profile.notes,
    name: cfg.name,
    baseUrl: cfg.baseUrl,
    tenantId: cfg.tenantId,
    authMode: cfg.authMode,
    oauthClientId: cfg.oauthClientId,
    oauthClientSecretMasked: maskSecret(cfg.oauthClientSecretEnc),
    oauthTokenUrl: cfg.oauthTokenUrl,
    oauthScope: cfg.oauthScope,
    apiKeyMasked: maskSecret(cfg.apiKeyEnc),
    apiKeyHeader: cfg.apiKeyHeader,
    basicUsername: cfg.basicUsername,
    basicPasswordSet: Boolean(cfg.basicPasswordEnc),
    webhookSecretSet: Boolean(cfg.webhookSecretEnc),
    webhookEnabled: cfg.webhookEnabled,
    webhookUrl: `${ENV.appUrl || ""}/api/webhooks/cbs/${cfg.id}`,
    batchSyncEnabled: cfg.batchSyncEnabled,
    batchSyncHourUtc: cfg.batchSyncHourUtc,
    writeBackEnabled: cfg.writeBackEnabled,
    pageSize: cfg.pageSize,
    maxRetries: cfg.maxRetries,
    requestTimeoutMs: cfg.requestTimeoutMs,
    endpointsJson: cfg.endpointsJson,
    isEnabled: cfg.isEnabled,
    lastHealthStatus: cfg.lastHealthStatus,
    lastHealthCheckAt: cfg.lastHealthCheckAt,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
  };
}

/** "" clears a secret, undefined keeps it, a value replaces it. */
function secretUpdate(input: string | undefined): { set: boolean; value: string | null } {
  if (input === undefined) return { set: false, value: null };
  if (input === "") return { set: true, value: null };
  return { set: true, value: encryptSecret(input) };
}

export const woodcoreConnectorRouter = router({
  /** Supported core-banking platforms (for the onboarding hub + connector UI). */
  listCbsProfiles: protectedProcedure.query(() => listCbsProfiles()),

  // ─── Configuration ─────────────────────────────────────────────────────────
  getConfig: protectedProcedure.input(orgOverrideInput.optional()).query(async ({ ctx, input }) => {
    const orgId = resolveOrgId(ctx.user, input?.organizationId);
    const cfg = await getConfigRowByOrg(orgId);
    return cfg ? toClientConfig(cfg) : null;
  }),

  saveConfig: connectorAdminProcedure
    .input(
      z.object({
        cbsType: z.enum(["woodcore", "t24", "mambu", "flexcube"]).optional(), // set on create; changing later is deliberate
        name: z.string().min(1).max(255).optional(),
        baseUrl: z.string().url().max(500),
        tenantId: z.string().min(1).max(100).default("default"),
        authMode: z.enum(["oauth2", "api_key", "basic"]),
        oauthClientId: z.string().max(255).optional(),
        oauthClientSecret: z.string().max(1000).optional(), // undefined = keep
        oauthTokenUrl: z.string().max(500).optional(),
        oauthScope: z.string().max(255).optional(),
        apiKey: z.string().max(1000).optional(),
        apiKeyHeader: z.string().min(1).max(100).default("x-api-key"),
        basicUsername: z.string().max(255).optional(),
        basicPassword: z.string().max(1000).optional(),
        webhookSecret: z.string().max(1000).optional(),
        webhookEnabled: z.boolean().default(true),
        batchSyncEnabled: z.boolean().default(true),
        batchSyncHourUtc: z.number().int().min(0).max(23).default(2),
        writeBackEnabled: z.boolean().default(false),
        pageSize: z.number().int().min(50).max(2000).default(500),
        maxRetries: z.number().int().min(0).max(10).default(3),
        requestTimeoutMs: z.number().int().min(5000).max(120000).default(30000),
        endpointsJson: z.record(z.string(), z.string()).optional(),
        isEnabled: z.boolean().default(false),
        organizationId: z.number().int().positive().optional(), // super admins only
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const existing = await getConfigRowByOrg(orgId);
      const oauthSecret = secretUpdate(input.oauthClientSecret);
      const apiKey = secretUpdate(input.apiKey);
      const basicPassword = secretUpdate(input.basicPassword);
      const webhookSecret = secretUpdate(input.webhookSecret);

      const effectiveCbsType = input.cbsType ?? existing?.cbsType ?? "woodcore";
      const common = {
        cbsType: effectiveCbsType,
        name: input.name ?? `${getCbsProfile(effectiveCbsType).label} Core Banking`,
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        tenantId: input.tenantId,
        authMode: input.authMode,
        oauthClientId: input.oauthClientId ?? null,
        oauthTokenUrl: input.oauthTokenUrl ?? null,
        oauthScope: input.oauthScope ?? null,
        apiKeyHeader: input.apiKeyHeader,
        basicUsername: input.basicUsername ?? null,
        webhookEnabled: input.webhookEnabled,
        batchSyncEnabled: input.batchSyncEnabled,
        batchSyncHourUtc: input.batchSyncHourUtc,
        writeBackEnabled: input.writeBackEnabled,
        pageSize: input.pageSize,
        maxRetries: input.maxRetries,
        requestTimeoutMs: input.requestTimeoutMs,
        endpointsJson: input.endpointsJson ?? null,
        isEnabled: input.isEnabled,
      };

      if (existing) {
        await db
          .update(wcConnectorConfigs)
          .set({
            ...common,
            ...(oauthSecret.set ? { oauthClientSecretEnc: oauthSecret.value } : {}),
            ...(apiKey.set ? { apiKeyEnc: apiKey.value } : {}),
            ...(basicPassword.set ? { basicPasswordEnc: basicPassword.value } : {}),
            ...(webhookSecret.set ? { webhookSecretEnc: webhookSecret.value } : {}),
          })
          .where(eq(wcConnectorConfigs.id, existing.id));
      } else {
        await db.insert(wcConnectorConfigs).values({
          organizationId: orgId,
          ...common,
          oauthClientSecretEnc: oauthSecret.value,
          apiKeyEnc: apiKey.value,
          basicPasswordEnc: basicPassword.value,
          webhookSecretEnc: webhookSecret.value,
        });
      }
      const saved = await getConfigRowByOrg(orgId);
      return saved ? toClientConfig(saved) : null;
    }),

  testConnection: connectorAdminProcedure
    .input(orgOverrideInput.optional())
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input?.organizationId);
      const cfg = await requireOrgConfig(orgId);
      return testConnection(cfg);
    }),

  // ─── Health dashboard ──────────────────────────────────────────────────────
  getHealth: protectedProcedure
    .input(z.object({ probe: z.boolean().default(false), organizationId: z.number().int().positive().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input?.organizationId);
      const cfg = await getConfigRowByOrg(orgId);
      if (!cfg) return null;
      return getConnectorHealth(cfg, { runConnectivityProbe: input?.probe ?? false });
    }),

  listSyncRuns: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(30), organizationId: z.number().int().positive().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input?.organizationId);
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(wcConnectorSyncRuns)
        .where(eq(wcConnectorSyncRuns.organizationId, orgId))
        .orderBy(desc(wcConnectorSyncRuns.startedAt))
        .limit(input?.limit ?? 30);
    }),

  listWebhookEvents: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          status: z.enum(["received", "processed", "failed", "duplicate", "quarantined"]).optional(),
          organizationId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input?.organizationId);
      const db = await getDb();
      if (!db) return [];
      const where = input?.status
        ? and(
            eq(wcConnectorWebhookEvents.organizationId, orgId),
            eq(wcConnectorWebhookEvents.status, input.status),
          )
        : eq(wcConnectorWebhookEvents.organizationId, orgId);
      return db
        .select({
          id: wcConnectorWebhookEvents.id,
          eventId: wcConnectorWebhookEvents.eventId,
          eventType: wcConnectorWebhookEvents.eventType,
          entity: wcConnectorWebhookEvents.entity,
          status: wcConnectorWebhookEvents.status,
          error: wcConnectorWebhookEvents.error,
          receivedAt: wcConnectorWebhookEvents.receivedAt,
          processedAt: wcConnectorWebhookEvents.processedAt,
        })
        .from(wcConnectorWebhookEvents)
        .where(where)
        .orderBy(desc(wcConnectorWebhookEvents.receivedAt))
        .limit(input?.limit ?? 50);
    }),

  // ─── Sync control ──────────────────────────────────────────────────────────
  triggerSync: connectorAdminProcedure
    .input(
      z
        .object({
          scope: z.enum(["savings", "loans", "gl", "all"]).default("all"),
          windowFrom: z.date().optional(),
          windowTo: z.date().optional(),
          organizationId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input?.organizationId);
      const cfg = await requireOrgConfig(orgId);
      if (!cfg.isEnabled) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Enable the connector before running a sync" });
      }
      // Fire-and-forget: the dashboard polls listSyncRuns for progress.
      runBatchSync(cfg.id, {
        trigger: input?.windowFrom ? "backfill" : "manual",
        scope: input?.scope ?? "all",
        windowFrom: input?.windowFrom,
        windowTo: input?.windowTo,
      }).catch((e) => console.error("[wc-connector] manual sync failed:", e));
      return { started: true };
    }),

  // ─── Dead letters ──────────────────────────────────────────────────────────
  listDeadLetters: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          status: z.enum(["pending", "retrying", "resolved", "exhausted", "discarded"]).optional(),
          organizationId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input?.organizationId);
      const db = await getDb();
      if (!db) return [];
      const where = input?.status
        ? and(
            eq(wcConnectorDeadLetters.organizationId, orgId),
            eq(wcConnectorDeadLetters.status, input.status),
          )
        : eq(wcConnectorDeadLetters.organizationId, orgId);
      return db
        .select()
        .from(wcConnectorDeadLetters)
        .where(where)
        .orderBy(desc(wcConnectorDeadLetters.createdAt))
        .limit(input?.limit ?? 50);
    }),

  replayDeadLetter: connectorAdminProcedure
    .input(z.object({ id: z.number().int().positive(), organizationId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const ok = await replayDeadLetter(input.id, orgId);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Dead letter not found or already resolved" });
      return { ok: true };
    }),

  discardDeadLetter: connectorAdminProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().min(1).max(1000), organizationId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const ok = await discardDeadLetter(input.id, orgId, input.note);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Dead letter not found" });
      return { ok: true };
    }),

  retryDeadLettersNow: connectorAdminProcedure
    .input(orgOverrideInput.optional())
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input?.organizationId);
      const cfg = await requireOrgConfig(orgId);
      return processDueDeadLetters(dlqHandlers, { configId: cfg.id, limit: 100 });
    }),

  // ─── Field mappings ────────────────────────────────────────────────────────
  getFieldMappings: protectedProcedure.input(orgOverrideInput.optional()).query(async ({ ctx, input }) => {
    const orgId = resolveOrgId(ctx.user, input?.organizationId);
    const cfg = await getConfigRowByOrg(orgId);
    const profile = getCbsProfile(cfg?.cbsType);
    const db = await getDb();
    const overrides: Record<string, { version: number; rules: MappingRule[]; notes: string | null } | null> = {
      savings_transaction: null,
      loan_transaction: null,
      journal_entry: null,
    };
    if (cfg && db) {
      const rows = await db
        .select()
        .from(wcConnectorFieldMappings)
        .where(
          and(
            eq(wcConnectorFieldMappings.configId, cfg.id),
            eq(wcConnectorFieldMappings.isActive, true),
          ),
        )
        .orderBy(wcConnectorFieldMappings.version);
      for (const row of rows) {
        overrides[row.entity] = {
          version: row.version,
          rules: (row.rulesJson as MappingRule[]) ?? [],
          notes: row.notes,
        };
      }
    }
    return {
      cbsType: profile.type,
      cbsLabel: profile.label,
      defaults: profile.apiMappings,
      csvDefaults: profile.csvMappings,
      overrides,
    };
  }),

  saveFieldMapping: connectorAdminProcedure
    .input(
      z.object({
        entity: entitySchema,
        rules: z.array(
          z.object({
            target: z.string().min(1).max(50),
            source: z.string().min(1).max(500),
            transform: z.string().max(50).optional(),
            default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          }),
        ),
        notes: z.string().max(1000).optional(),
        organizationId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const cfg = await requireOrgConfig(orgId);
      const check = validateRules(input.rules);
      if (!check.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid mapping rules: ${check.errors.join("; ")}` });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Deactivate the previous version, insert the next.
      const prior = await db
        .select()
        .from(wcConnectorFieldMappings)
        .where(
          and(
            eq(wcConnectorFieldMappings.configId, cfg.id),
            eq(wcConnectorFieldMappings.entity, input.entity),
          ),
        )
        .orderBy(desc(wcConnectorFieldMappings.version))
        .limit(1);
      const nextVersion = (prior[0]?.version ?? 0) + 1;
      if (prior[0]) {
        await db
          .update(wcConnectorFieldMappings)
          .set({ isActive: false })
          .where(
            and(
              eq(wcConnectorFieldMappings.configId, cfg.id),
              eq(wcConnectorFieldMappings.entity, input.entity),
            ),
          );
      }
      await db.insert(wcConnectorFieldMappings).values({
        configId: cfg.id,
        organizationId: orgId,
        entity: input.entity,
        version: nextVersion,
        rulesJson: input.rules,
        isActive: true,
        notes: input.notes ?? null,
        createdBy: ctx.user.id,
      });
      return { ok: true, version: nextVersion };
    }),

  /** Paste a sample CBS payload, see exactly what ReconcileAI will store. */
  previewMapping: protectedProcedure
    .input(
      z.object({
        entity: entitySchema,
        samplePayload: z.string().min(2).max(100_000),
        cbsType: z.enum(["woodcore", "t24", "mambu", "flexcube"]).optional(), // default: the org's connector
        organizationId: z.number().int().positive().optional(),
        rules: z
          .array(
            z.object({
              target: z.string(),
              source: z.string(),
              transform: z.string().optional(),
              default: z.union([z.string(), z.number(), z.boolean()]).optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let payload: unknown;
      try {
        payload = JSON.parse(input.samplePayload);
      } catch {
        return { ok: false as const, errors: ["Sample is not valid JSON"], preview: null };
      }
      let cbsType = input.cbsType;
      if (!cbsType) {
        const orgId = resolveOrgId(ctx.user, input.organizationId);
        const cfg = await getConfigRowByOrg(orgId);
        cbsType = (cfg?.cbsType as typeof cbsType) ?? "woodcore";
      }
      const profile = getCbsProfile(cbsType);
      const result = applyMapping(
        input.entity,
        payload,
        (input.rules as MappingRule[] | undefined) ?? null,
        profile.apiMappings[input.entity],
      );
      if (!result.ok || !result.value) {
        return { ok: false as const, errors: result.errors, preview: null };
      }
      const v = result.value;
      return {
        ok: true as const,
        errors: [],
        preview: {
          externalRef: v.externalRef,
          transactionRef: v.transactionRef,
          amount: v.amount,
          currency: v.currency,
          debitCredit: v.debitCredit,
          transactionDate: v.transactionDate.toISOString(),
          valueDate: v.valueDate?.toISOString() ?? null,
          description: v.description,
          counterparty: v.counterparty,
          isReversal: v.isReversal,
          sourceType: v.sourceType,
        },
      };
    }),

  // ─── Bidirectional write-back ──────────────────────────────────────────────
  sendWriteBackNote: connectorAdminProcedure
    .input(
      z.object({
        accountType: z.enum(["savings", "loan", "gl"]),
        accountId: z.string().min(1).max(100),
        reconcileRef: z.string().min(1).max(100),
        note: z.string().min(1).max(1000),
        organizationId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const cfg = await requireOrgConfig(orgId);
      return pushWriteBackNote(cfg.id, {
        accountType: input.accountType,
        accountId: input.accountId,
        reconcileRef: input.reconcileRef,
        note: input.note,
      });
    }),

  // ─── Partner-channel onboarding (Infinity AI super admins) ────────────────
  // The connector is the onboarding bridge for CBS-partner client banks: one
  // call provisions org + admin + connector config + channel, and the
  // institution gets its own org-scoped ReconcileAI interface. Direct clients
  // do not use this path (superAdmin.createOrganization, channel "direct").
  onboardClient: superAdminProcedure
    .input(
      z.object({
        cbsType: z.enum(["woodcore", "t24", "mambu", "flexcube"]).default("woodcore"),
        orgName: z.string().min(2).max(255),
        orgCode: z.string().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/).optional(),
        country: z.string().length(3).default("NGA"),
        baseCurrency: z.string().length(3).default("NGN"),
        adminName: z.string().min(1).max(255),
        adminEmail: z.string().email().max(320),
        origin: z.string().url().max(500).optional(),
        connector: z
          .object({
            baseUrl: z.string().url().max(500).optional(),
            tenantId: z.string().max(100).optional(),
            authMode: z.enum(["oauth2", "api_key", "basic"]).optional(),
            oauthClientId: z.string().max(255).optional(),
            oauthClientSecret: z.string().max(1000).optional(),
            apiKey: z.string().max(1000).optional(),
            webhookSecret: z.string().max(1000).optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { onboardCbsClient, OnboardingError } = await import("../connectors/woodcore/onboarding");
      try {
        const result = await onboardCbsClient(input);
        // Platform audit trail (same event stream as direct org creation).
        try {
          const dbHelpers = await import("../db");
          await dbHelpers.logPlatformEvent({
            actorId: ctx.user.id,
            actorName: ctx.user.name ?? undefined,
            eventType: "org_created",
            targetType: "organization",
            targetId: result.organizationId,
            targetName: input.orgName,
            newValue: JSON.stringify({ onboardingChannel: input.cbsType, configId: result.configId }),
          });
        } catch (e) {
          console.error("[wc-onboarding] platform event failed:", e);
        }
        return result;
      } catch (err) {
        if (err instanceof OnboardingError) {
          const code =
            err.code === "DUPLICATE_EMAIL" || err.code === "DUPLICATE_ORG" ? "CONFLICT" : "INTERNAL_SERVER_ERROR";
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }
    }),

  /** All organizations onboarded through any CBS channel, with connector state. */
  listOnboardedClients: superAdminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const { organizations } = await import("../../drizzle/schema");
    const orgs = await db
      .select()
      .from(organizations)
      .where(ne(organizations.onboardingChannel, "direct"))
      .orderBy(desc(organizations.createdAt));
    const configs = await db.select().from(wcConnectorConfigs);
    const byOrg = new Map(configs.map((c) => [c.organizationId, c]));
    return orgs.map((o) => {
      const cfg = byOrg.get(o.id);
      return {
        organizationId: o.id,
        name: o.name,
        code: o.code,
        onboardingChannel: o.onboardingChannel,
        cbsLabel: getCbsProfile(o.onboardingChannel).label,
        isActive: o.isActive,
        createdAt: o.createdAt,
        connector: cfg
          ? {
              configId: cfg.id,
              cbsType: cfg.cbsType,
              isEnabled: cfg.isEnabled,
              baseUrlSet: Boolean(cfg.baseUrl),
              lastHealthStatus: cfg.lastHealthStatus,
              lastHealthCheckAt: cfg.lastHealthCheckAt,
            }
          : null,
      };
    });
  }),

  // ─── CSV fallback import (no API access yet, or historical backfill) ──────
  importCsv: connectorAdminProcedure
    .input(
      z.object({
        entity: entitySchema,
        csvContent: z.string().min(10).max(30 * 1024 * 1024), // 30MB text cap
        fileName: z.string().max(300).optional(),
        organizationId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const cfg = await requireOrgConfig(orgId);
      return importCbsCsv(cfg, input.entity, input.csvContent, { fileName: input.fileName });
    }),
});
