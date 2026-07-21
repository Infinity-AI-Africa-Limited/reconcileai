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
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  slConnectorStores,
  slConnectorWebhookEvents,
} from "../../drizzle/connector_schema";
import { channels, transactions, exceptions } from "../../drizzle/schema";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  verifyCallbackSignature,
} from "../connectors/shopline/auth";
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
   * Security model:
   *  - The `sign` over the callback query params is verified (HMAC-SHA256 with
   *    the app secret) — without it anyone could post codes at this endpoint.
   *  - The organization is resolved from the already-provisioned store row for
   *    this handle. The `customField`/state value is attacker-controllable (a
   *    merchant can hand-craft the authorize URL), so it is NEVER trusted to
   *    bind a store to an existing organization. Unknown stores are rejected
   *    here; self-serve onboarding provisions its own org in the onboarding
   *    module before re-entering this exchange.
   */
  oauthCallback: publicProcedure
    .input(
      z.object({
        code: z.string(),
        /** Store handle — arrives as `handle` on the wire */
        shop: z.string(),
        appkey: z.string(),
        timestamp: z.string(),
        sign: z.string(),
        customField: z.string().optional(),
        lang: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Reconstruct the wire query params exactly as SHOPLINE signed them
      const wireParams: Record<string, string> = {
        appkey: input.appkey,
        code: input.code,
        handle: input.shop,
        timestamp: input.timestamp,
        sign: input.sign,
      };
      if (input.customField !== undefined) wireParams.customField = input.customField;
      if (input.lang !== undefined) wireParams.lang = input.lang;

      if (input.appkey !== ENV.shoplineAppKey || !verifyCallbackSignature(wireParams)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid SHOPLINE callback signature" });
      }

      // Resolve the organization from the provisioned store row — not from state
      const provisioned = await db
        .select({ id: slConnectorStores.id, organizationId: slConnectorStores.organizationId })
        .from(slConnectorStores)
        .where(eq(slConnectorStores.storeHandle, input.shop))
        .limit(1);

      if (provisioned.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Store ${input.shop} is not provisioned for any organization — run provisioning (or self-serve onboarding) first`,
        });
      }
      const organizationId = provisioned[0].organizationId;

      // Exchange code for token
      const tokenResponse = await exchangeCodeForToken(input.shop, input.code);

      // Fetch store metadata
      const shopMeta = await fetchStoreMetadata({
        storeHandle: input.shop,
        accessToken: tokenResponse.accessToken,
      });

      // Activate the provisioned store row with live metadata
      const storeId = provisioned[0].id;
      await db
        .update(slConnectorStores)
        .set({
          status: "active",
          storeId: shopMeta.id,
          merchantId: shopMeta.merchant_id,
          domain: shopMeta.domain,
          currency: shopMeta.currency,
          ianaTimezone: shopMeta.iana_timezone,
          installedAt: new Date(),
          uninstalledAt: null,
          grantedScopes: tokenResponse.scope || SHOPLINE_REQUIRED_SCOPES.join(","),
        })
        .where(eq(slConnectorStores.id, storeId));

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
   * Exception intelligence for a retail exception category — both layers:
   *   ownHistory : this merchant's own past resolutions (intra-org, private)
   *   network    : anonymised cross-merchant recommendations (k-anonymous)
   * Powers the exception-detail / settlement-monitor "how to resolve" panel.
   */
  exceptionIntelligence: protectedProcedure
    .input(
      z.object({
        category: z.string().min(1),
        amount: z.number().optional(),
        organizationId: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const { getRetailExceptionIntelligence } = await import("../connectors/shopline/retailIntelligence");
      return getRetailExceptionIntelligence(orgId, input.category, input.amount ?? 0);
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

      // The callback resolves the org from this provisioned row, so no org
      // data needs to travel in customField. APP_URL is the canonical origin
      // and must match a callback URL registered in the Partner Portal.
      const installUrl = buildAuthorizationUrl({
        storeHandle: input.storeHandle,
        callbackUrl: `${ENV.appUrl}/api/shopline/callback`,
      });

      return { success: true, storeId: newStoreId, installUrl };
    }),

  /**
   * Sync status overview — aggregated metrics for the settlement monitor.
   * Derived from real reconciliation state in the transactions table (scoped
   * to this org's SHOPLINE channels), not from webhook-delivery counts.
   */
  syncStatus: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    const orgId = requireOrgId(ctx.user);

    // This org's SHOPLINE channels (retail_commerce orgs are SHOPLINE-only, but
    // filter by channel type so a mixed org stays correct).
    const orgChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.organizationId, orgId), eq(channels.channelType, "ecommerce_gateway")));
    const channelIds = orgChannels.map((c) => c.id);

    // Reconciliation state, computed in-DB in a single pass.
    const [agg] = channelIds.length
      ? await db
          .select({
            matched: sql<number>`sum(case when ${transactions.status} in ('matched','manually_matched') then 1 else 0 end)`,
            settledAmount: sql<number>`coalesce(sum(case when ${transactions.status} in ('matched','manually_matched') then abs(${transactions.amount}) else 0 end), 0)`,
            pendingAmount: sql<number>`coalesce(sum(case when ${transactions.status} = 'unmatched' then abs(${transactions.amount}) else 0 end), 0)`,
            pendingCount: sql<number>`sum(case when ${transactions.status} = 'unmatched' then 1 else 0 end)`,
            total: sql<number>`count(*)`,
          })
          .from(transactions)
          .where(inArray(transactions.channelId, channelIds))
      : [{ matched: 0, settledAmount: 0, pendingAmount: 0, pendingCount: 0, total: 0 }];

    const matched = Number(agg?.matched ?? 0);
    const total = Number(agg?.total ?? 0);

    // Open exceptions on this org's SHOPLINE transactions.
    const [exAgg] = channelIds.length
      ? await db
          .select({ open: sql<number>`count(*)` })
          .from(exceptions)
          .innerJoin(transactions, eq(exceptions.transactionId, transactions.id))
          .where(and(inArray(transactions.channelId, channelIds), eq(exceptions.status, "open")))
      : [{ open: 0 }];

    return {
      totalSettled: Number(agg?.settledAmount ?? 0),
      totalPending: Number(agg?.pendingAmount ?? 0),
      totalExceptions: Number(exAgg?.open ?? 0),
      matchRate: total > 0 ? (matched / total) * 100 : 0,
      matchedCount: matched,
      pendingCount: Number(agg?.pendingCount ?? 0),
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

      // A manual "Sync Now" is a catch-up action — use a 24h window (not the
      // 15-min incremental window) so a merchant clicking it actually backfills.
      const now = new Date();
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const report = await runSyncCycle({
        organizationId: orgId,
        slStoreId: store.id,
        from,
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
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      return db
        .select()
        .from(slConnectorStores)
        .orderBy(desc(slConnectorStores.installedAt))
        .limit(input.limit);
    }),
});
