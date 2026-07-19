/**
 * SHOPLINE Connector tRPC Router — Phase 1
 *
 * Procedures:
 *   Public (no auth):
 *     shoplineConnector.oauthCallback   — SHOPLINE OAuth callback (install flow)
 *     shoplineConnector.webhook         — Inbound webhook delivery endpoint
 *
 *   Protected (authenticated):
 *     shoplineConnector.listStores      — List all SHOPLINE stores for the org
 *     shoplineConnector.getStore        — Get a single store with sync status
 *     shoplineConnector.syncNow         — Trigger manual settlement sync
 *     shoplineConnector.registerWebhooks — Register all required webhook topics
 *     shoplineConnector.uninstall       — Remove a store connection
 *
 *   Admin only:
 *     shoplineConnector.provisionStore  — Super admin: provision a store for a client org
 *     shoplineConnector.listAllStores   — Super admin: list all stores across all orgs
 *
 * Access model mirrors woodcoreConnector: reads for any org member, writes for admin+.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  slConnectorStores,
  slConnectorWebhookEvents,
} from "../../drizzle/connector_schema";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { exchangeCodeForToken } from "../connectors/shopline/auth";
import { getValidToken, saveToken, deleteToken } from "../connectors/shopline/tokenStore";
import { ingestWebhook } from "../connectors/shopline/webhookHandler";
import { runSettlementSync } from "../connectors/shopline/settlementSync";
import { registerWebhook, listWebhooks, fetchStoreMetadata } from "../connectors/shopline/apiClient";
import { ENV } from "../_core/env";
import {
  SHOPLINE_WEBHOOK_TOPICS,
  SHOPLINE_REQUIRED_SCOPES,
} from "../../shared/shoplineConstants";

// ─── Access control helpers ────────────────────────────────────────────────

const connectorAdminProcedure = protectedProcedure.use(async (opts) => {
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

function requireOrgId(user: { organizationId?: number | null }): number {
  if (!user.organizationId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is not linked to an organization",
    });
  }
  return user.organizationId;
}

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

// ─── Router ────────────────────────────────────────────────────────────────

export const shoplineConnectorRouter = router({

  /**
   * SHOPLINE OAuth callback — called by SHOPLINE after merchant approves install.
   * Exchanges the authorization code for an access token and creates the store record.
   *
   * Query params: code, shop (store handle), state (contains orgId)
   */
  oauthCallback: publicProcedure
    .input(
      z.object({
        code: z.string(),
        shop: z.string(),
        state: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Decode state to get organizationId
      let organizationId: number;
      try {
        const decoded = JSON.parse(Buffer.from(input.state, "base64").toString("utf8"));
        organizationId = Number(decoded.orgId);
        if (!organizationId || isNaN(organizationId)) throw new Error("Invalid orgId");
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid OAuth state parameter" });
      }

      // Exchange code for token
      const tokenResponse = await exchangeCodeForToken(input.shop, input.code);

      // Fetch store metadata
      const shopMeta = await fetchStoreMetadata({
        storeHandle: input.shop,
        accessToken: tokenResponse.accessToken,
      });

      // Upsert store record
      const existing = await db
        .select({ id: slConnectorStores.id })
        .from(slConnectorStores)
        .where(
          and(
            eq(slConnectorStores.storeHandle, input.shop),
            eq(slConnectorStores.organizationId, organizationId),
          ),
        )
        .limit(1);

      let storeId: number;
      if (existing.length > 0) {
        storeId = existing[0].id;
        await db
          .update(slConnectorStores)
          .set({
            status: "active",
            storeId: shopMeta.id,
            
            domain: shopMeta.domain,
            currency: shopMeta.currency,
            ianaTimezone: shopMeta.iana_timezone,
            installedAt: new Date(),
            uninstalledAt: null,
            grantedScopes: SHOPLINE_REQUIRED_SCOPES.join(","),
          })
          .where(eq(slConnectorStores.id, storeId));
      } else {
        const [inserted] = await db.insert(slConnectorStores).values({
          organizationId,
          storeHandle: input.shop,
          storeId: shopMeta.id,
          
          domain: shopMeta.domain,
          currency: shopMeta.currency,
          ianaTimezone: shopMeta.iana_timezone,
          status: "active",
          installedAt: new Date(),
          grantedScopes: SHOPLINE_REQUIRED_SCOPES.join(","),
        });
        storeId = (inserted as { insertId: number }).insertId;
      }

      // Persist encrypted token
      await saveToken(db, storeId, organizationId, tokenResponse);

      return { success: true, storeId, storeName: shopMeta.name };
    }),

  /**
   * Inbound webhook delivery from SHOPLINE.
   * SHOPLINE expects a 200 response within 5 seconds.
   */
  webhook: publicProcedure
    .input(
      z.object({
        webhookId: z.string(),
        topic: z.string(),
        hmacSignature: z.string(),
        shopDomain: z.string(),
        rawBody: z.string(), // base64-encoded raw body
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const rawBody = Buffer.from(input.rawBody, "base64");

      const result = await ingestWebhook(db, {
        webhookId: input.webhookId,
        topic: input.topic,
        hmacSignature: input.hmacSignature,
        shopDomain: input.shopDomain,
        rawBody,
      });

      // Always return 200 to SHOPLINE (even on duplicate/store-not-found)
      return { received: true, status: result.status };
    }),

  /**
   * List all SHOPLINE stores connected to the caller's organization.
   */
  listStores: protectedProcedure
    .input(z.object({ organizationId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const orgId = resolveOrgId(ctx.user, input.organizationId);

      return db
        .select()
        .from(slConnectorStores)
        .where(eq(slConnectorStores.organizationId, orgId))
        .orderBy(desc(slConnectorStores.installedAt));
    }),

  /**
   * Get a single store with its sync status and recent webhook events.
   */
  getStore: protectedProcedure
    .input(z.object({ storeId: z.number(), organizationId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const stores = await db
        .select()
        .from(slConnectorStores)
        .where(
          and(
            eq(slConnectorStores.id, input.storeId),
            eq(slConnectorStores.organizationId, orgId),
          ),
        )
        .limit(1);

      if (stores.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Store not found" });
      }

      const recentEvents = await db
        .select()
        .from(slConnectorWebhookEvents)
        .where(eq(slConnectorWebhookEvents.slStoreId, input.storeId))
        .orderBy(desc(slConnectorWebhookEvents.receivedAt))
        .limit(20);

      return { store: stores[0], recentEvents };
    }),

  /**
   * Trigger a manual settlement sync for a store.
   * Defaults to the last 7 days if no window is specified.
   */
  syncNow: connectorAdminProcedure
    .input(
      z.object({
        storeId: z.number(),
        organizationId: z.number().optional(),
        fromDate: z.string().optional(),
        toDate: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const to = input.toDate ? new Date(input.toDate) : new Date();
      const from = input.fromDate
        ? new Date(input.fromDate)
        : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

      const result = await runSettlementSync(db, orgId, input.storeId, { from, to });

      if (result.error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: result.error,
        });
      }

      return result;
    }),

  /**
   * Register all required webhook topics for a store.
   * Idempotent — skips topics that are already registered.
   */
  registerWebhooks: connectorAdminProcedure
    .input(
      z.object({
        storeId: z.number(),
        organizationId: z.number().optional(),
        callbackBaseUrl: z.string().url(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const stores = await db
        .select()
        .from(slConnectorStores)
        .where(
          and(
            eq(slConnectorStores.id, input.storeId),
            eq(slConnectorStores.organizationId, orgId),
          ),
        )
        .limit(1);

      if (stores.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Store not found" });
      }

      const store = stores[0];
      const accessToken = await getValidToken(db, input.storeId, orgId, store.storeHandle);
      if (!accessToken) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No valid access token — re-install required" });
      }

      const opts = { storeHandle: store.storeHandle, accessToken };
      const existingWebhooks = await listWebhooks(opts);
      const existingTopics = new Set(existingWebhooks.map((w) => w.topic));

      const registered: string[] = [];
      const skipped: string[] = [];

      for (const topic of SHOPLINE_WEBHOOK_TOPICS) {
        if (existingTopics.has(topic)) {
          skipped.push(topic);
          continue;
        }
        const callbackUrl = `${input.callbackBaseUrl}/api/shopline/webhook`;
        await registerWebhook(opts, topic, callbackUrl);
        registered.push(topic);
      }

      return { registered, skipped };
    }),

  /**
   * Uninstall a SHOPLINE store connection (delete token + mark as uninstalled).
   */
  uninstall: connectorAdminProcedure
    .input(z.object({ storeId: z.number(), organizationId: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const orgId = resolveOrgId(ctx.user, input.organizationId);

      await db
        .update(slConnectorStores)
        .set({ status: "uninstalled", uninstalledAt: new Date() })
        .where(
          and(
            eq(slConnectorStores.id, input.storeId),
            eq(slConnectorStores.organizationId, orgId),
          ),
        );

      await deleteToken(db, input.storeId);

      return { success: true };
    }),

  /**
   * Super admin: provision a SHOPLINE store for a client organization.
   * Used during onboarding to set up the store record before the OAuth install.
   */
  provisionStore: superAdminProcedure
    .input(
      z.object({
        organizationId: z.number(),
        storeHandle: z.string().min(1),
        storeShoplineId: z.string().min(1),
        currency: z.string().length(3).default("USD"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [inserted] = await db.insert(slConnectorStores).values({
        organizationId: input.organizationId,
        storeHandle: input.storeHandle,
        storeId: input.storeShoplineId,
        currency: input.currency,
        status: "active",
      });

      const newStoreId = (inserted as { insertId: number }).insertId;

      const installUrl = `https://${input.storeHandle}.myshopline.com/admin/oauth-web/#/oauth/authorize?appKey=${ENV.shoplineAppKey}&responseType=code&scope=${SHOPLINE_REQUIRED_SCOPES.join(",")}&redirectUri=${encodeURIComponent(`${ENV.forgeApiUrl}/shopline/oauth/callback`)}&customField=${Buffer.from(JSON.stringify({ orgId: input.organizationId })).toString("base64")}`;

      return { success: true, storeId: newStoreId, installUrl };
    }),

  /**
   * Sync status overview — aggregated metrics for the settlement monitor.
   */
  syncStatus: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    const orgId = requireOrgId(ctx.user);

    // Get recent webhook events for this org
    const events = await db
      .select()
      .from(slConnectorWebhookEvents)
      .where(eq(slConnectorWebhookEvents.organizationId, orgId))
      .orderBy(desc(slConnectorWebhookEvents.receivedAt))
      .limit(100);

    const processedEvents = events.filter((e) => e.status === "processed");
    const failedEvents = events.filter((e) => e.status === "failed" || e.status === "dlq");

    // Calculate basic metrics from webhook event data
    // In production, these would come from the transactions/exceptions tables
    const totalEvents = events.length;
    const matchRate = totalEvents > 0 ? (processedEvents.length / totalEvents) * 100 : 0;

    return {
      totalSettled: 0, // Will be populated from transactions table once data flows
      totalPending: 0,
      totalExceptions: failedEvents.length,
      matchRate,
      recentPayouts: [] as Array<{
        id: number;
        date: string;
        storeHandle: string;
        amount: number;
        currency: string;
        status: string;
        reconciled: boolean;
      }>,
    };
  }),

  /**
   * Recent webhook events for the sync status page.
   */
  recentWebhookEvents: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const orgId = requireOrgId(ctx.user);

      const events = await db
        .select({
          id: slConnectorWebhookEvents.id,
          topic: slConnectorWebhookEvents.topic,
          status: slConnectorWebhookEvents.status,
          receivedAt: slConnectorWebhookEvents.receivedAt,
          slStoreId: slConnectorWebhookEvents.slStoreId,
        })
        .from(slConnectorWebhookEvents)
        .where(eq(slConnectorWebhookEvents.organizationId, orgId))
        .orderBy(desc(slConnectorWebhookEvents.receivedAt))
        .limit(input.limit);

      // Enrich with store handle
      const storeIds = Array.from(new Set(events.map((e) => e.slStoreId)));
      const stores = storeIds.length > 0
        ? await db
            .select({ id: slConnectorStores.id, storeHandle: slConnectorStores.storeHandle })
            .from(slConnectorStores)
            .where(eq(slConnectorStores.organizationId, orgId))
        : [];
      const storeMap = new Map(stores.map((s) => [s.id, s.storeHandle]));

      return events.map((e) => ({
        ...e,
        storeHandle: storeMap.get(e.slStoreId) ?? "unknown",
      }));
    }),

  /**
   * Trigger a manual sync for a specific store (any authenticated user).
   */
  triggerManualSync: protectedProcedure
    .input(z.object({ storeId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const orgId = requireOrgId(ctx.user);

      // Verify store belongs to org
      const stores = await db
        .select()
        .from(slConnectorStores)
        .where(
          and(
            eq(slConnectorStores.id, input.storeId),
            eq(slConnectorStores.organizationId, orgId),
          ),
        )
        .limit(1);

      if (stores.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Store not found" });
      }

      const store = stores[0];
      const { runSyncCycle } = await import("../connectors/shopline/syncOrchestrator");

      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      const now = new Date();

      const report = await runSyncCycle({
        organizationId: orgId,
        slStoreId: store.id,
        from: fifteenMinAgo,
        to: now,
        triggeredBy: ctx.user.id,
      });

      if (!report.success) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: report.error ?? "Sync failed",
        });
      }

      // Update lastSyncAt
      await db
        .update(slConnectorStores)
        .set({ lastSyncAt: new Date() })
        .where(eq(slConnectorStores.id, input.storeId));

      return {
        storeHandle: store.storeHandle,
        ordersIngested: report.ordersIngested,
        paymentsIngested: report.paymentsIngested,
        payoutsIngested: report.payoutsIngested,
        matchedCount: report.matchedCount,
        exceptionCount: report.exceptionCount,
        durationMs: report.durationMs,
      };
    }),

  /**
   * Super admin: list all SHOPLINE stores across all organizations.
   */
  listAllStores: superAdminProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }))
    .query(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      return db
        .select()
        .from(slConnectorStores)
        .orderBy(desc(slConnectorStores.installedAt))
        .limit(50);
    }),
});
