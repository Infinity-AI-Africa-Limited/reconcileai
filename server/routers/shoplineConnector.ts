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
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import {
  slConnectorStores,
  slConnectorWebhookEvents,
  slConnectorSubscriptions,
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
import {
  parseSettlementFile,
  detectColumns,
  mapSettlementRows,
} from "../connectors/shopline/settlementFileImport";
import {
  rejectAlreadyIngested,
  resolveChannelIds,
  runReconciliationOnPersistedData,
} from "../connectors/shopline/syncOrchestrator";
import { createUploadBatch, updateUploadBatch, insertTransactions } from "../db";
import { ingestWebhook } from "../connectors/shopline/webhookHandler";
import { runSettlementSync } from "../connectors/shopline/settlementSync";
import { registerWebhook, listWebhooks, fetchStoreMetadata } from "../connectors/shopline/apiClient";
import { ENV } from "../_core/env";
import { resolveOrgScope } from "../_core/tenancy";
import { logPlatformEvent } from "../db";
import {
  SHOPLINE_WEBHOOK_TOPICS,
  SHOPLINE_REQUIRED_SCOPES,
  getShoplineBand,
  getShoplinePlanLimits,
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
  return resolveOrgScope(user, override);
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
      // Authorise BEFORE touching the database. Refusing a caller needs no
      // connection, and resolving the scope second meant an unauthorised
      // cross-tenant request got INTERNAL_SERVER_ERROR rather than FORBIDDEN
      // whenever the database was down — the wrong answer, and one that also
      // made the guard untestable without a live database.
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

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
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

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
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { getRetailExceptionIntelligence } = await import("../connectors/shopline/retailIntelligence");
      return getRetailExceptionIntelligence(orgId, input.category, input.amount ?? 0);
    }),

  /**
   * Plan status for the org's SHOPLINE subscription — the platform's view of
   * the portal-managed pricing model: current plan + its LIMITS (orders/month,
   * connected stores), current usage against those limits, and grace-period
   * state. SHOPLINE runs the billing; this is how OUR side stays plan-aware
   * (surfaces overage/limit signals; the connector never charges anything).
   */
  planStatus: protectedProcedure
    .input(z.object({ organizationId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Subscription (may be null before the first billing webhook).
      const [sub] = await db
        .select()
        .from(slConnectorSubscriptions)
        .where(eq(slConnectorSubscriptions.organizationId, orgId))
        .orderBy(desc(slConnectorSubscriptions.id))
        .limit(1);

      const band = getShoplineBand(sub?.planId);
      const limits = getShoplinePlanLimits(sub?.planId);

      // Connected (active) stores for this org.
      const [storeAgg] = await db
        .select({ n: sql<number>`count(*)` })
        .from(slConnectorStores)
        .where(and(eq(slConnectorStores.organizationId, orgId), eq(slConnectorStores.status, "active")));
      const connectedStores = Number(storeAgg?.n ?? 0);

      // Orders reconciled this calendar month (order-leg channels).
      const orgChannels = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.organizationId, orgId), eq(channels.channelType, "ecommerce_gateway")));
      const channelIds = orgChannels.map((c) => c.id);
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [orderAgg] = channelIds.length
        ? await db
            .select({ n: sql<number>`count(*)` })
            .from(transactions)
            .where(
              and(
                inArray(transactions.channelId, channelIds),
                eq(transactions.debitCredit, "credit"),
                sql`${transactions.transactionDate} >= ${monthStart}`,
              ),
            )
        : [{ n: 0 }];
      const ordersThisMonth = Number(orderAgg?.n ?? 0);

      const grace =
        sub && (sub.status === "past_due" || sub.status === "expired")
          ? {
              graceEndsAt: sub.graceEndsAt,
              inGrace: !sub.graceEndsAt || (sub.graceEndsAt as Date).getTime() > Date.now(),
            }
          : { graceEndsAt: null, inGrace: false };

      return {
        planId: sub?.planId ?? null,
        planLabel: band?.label ?? null,
        status: sub?.status ?? null,
        trialEndsAt: sub?.trialEndsAt ?? null,
        limits: {
          maxOrders: Number.isFinite(limits.maxOrders) ? limits.maxOrders : null, // null = unlimited
          maxStores: Number.isFinite(limits.maxStores) ? limits.maxStores : null,
        },
        usage: { ordersThisMonth, connectedStores },
        overOrderLimit: Number.isFinite(limits.maxOrders) && ordersThisMonth > limits.maxOrders,
        atStoreLimit: Number.isFinite(limits.maxStores) && connectedStores >= limits.maxStores,
        grace,
      };
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
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

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
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

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
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

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
  syncStatus: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // This org's SHOPLINE channels (retail_commerce orgs are SHOPLINE-only, but
      // filter by channel type so a mixed org stays correct).
      const orgChannels = await db
        .select({ id: channels.id, code: channels.code })
        .from(channels)
        .where(and(eq(channels.organizationId, orgId), eq(channels.channelType, "ecommerce_gateway")));
      const channelIds = orgChannels.map((c) => c.id);
      // Channel codes are `sl_orders_<handle>` / `sl_payments_<handle>` (see
      // onboarding.ts), so the store handle is recoverable without another join.
      const handleByChannelId = new Map(
        orgChannels.map((c) => [c.id, c.code.replace(/^sl_(orders|payments)_/, "")]),
      );

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

      // Payment-leg presence. A merchant on a third-party gateway or COD has an
      // order book and no payment feed, which reconciles to a legitimate-looking
      // 0% match rate. Reporting the two sides separately lets the UI say WHY
      // instead of presenting an unexplained zero.
      const ordersChannelIds = orgChannels.filter((c) => c.code.startsWith("sl_orders_")).map((c) => c.id);
      const paymentsChannelIds = orgChannels.filter((c) => c.code.startsWith("sl_payments_")).map((c) => c.id);
      const countIn = async (ids: number[]) => {
        if (ids.length === 0) return 0;
        const [r] = await db
          .select({ n: sql<number>`count(*)` })
          .from(transactions)
          .where(inArray(transactions.channelId, ids));
        return Number(r?.n ?? 0);
      };
      const orderRowCount = await countIn(ordersChannelIds);
      const paymentRowCount = await countIn(paymentsChannelIds);

      // Sync health — so an empty dashboard can explain itself. A store whose
      // syncs are failing (or has never synced) otherwise renders as a page of
      // legitimate-looking zeros.
      const storeHealth = await db
        .select({
          storeHandle: slConnectorStores.storeHandle,
          lastSyncAt: slConnectorStores.lastSyncAt,
          lastSyncAttemptAt: slConnectorStores.lastSyncAttemptAt,
          lastSyncError: slConnectorStores.lastSyncError,
        })
        .from(slConnectorStores)
        .where(and(eq(slConnectorStores.organizationId, orgId), eq(slConnectorStores.status, "active")));

      // Recent payouts — the settlement leg. `normalisePayout` writes these with a
      // `PAYOUT_` transactionRef prefix (unique to payouts; orders/refunds/balance
      // txns use bare ids, `REFUND_` and `BT_`), and sets `valueDate` only when
      // SHOPLINE reported the payout as SUCCESS — which is what distinguishes a
      // paid payout from one still in flight.
      // NOTE: `_` is a LIKE wildcard in MySQL, so the prefix must be escaped.
      const payoutRows = channelIds.length
        ? await db
            .select({
              id: transactions.id,
              channelId: transactions.channelId,
              amount: transactions.amount,
              currency: transactions.currency,
              transactionDate: transactions.transactionDate,
              valueDate: transactions.valueDate,
              status: transactions.status,
            })
            .from(transactions)
            .where(
              and(
                inArray(transactions.channelId, channelIds),
                like(transactions.transactionRef, "PAYOUT\\_%"),
              ),
            )
            .orderBy(desc(transactions.transactionDate))
            .limit(20)
        : [];

      return {
        totalSettled: Number(agg?.settledAmount ?? 0),
        totalPending: Number(agg?.pendingAmount ?? 0),
        totalExceptions: Number(exAgg?.open ?? 0),
        matchRate: total > 0 ? (matched / total) * 100 : 0,
        matchedCount: matched,
        pendingCount: Number(agg?.pendingCount ?? 0),
        orderRowCount,
        paymentRowCount,
        /** Orders present but no payment leg at all — nothing to reconcile against. */
        paymentFeedMissing: orderRowCount > 0 && paymentRowCount === 0,
        syncHealth: storeHealth.map((s) => ({
          storeHandle: s.storeHandle,
          lastSyncAt: s.lastSyncAt ? s.lastSyncAt.toISOString() : null,
          lastSyncAttemptAt: s.lastSyncAttemptAt ? s.lastSyncAttemptAt.toISOString() : null,
          lastSyncError: s.lastSyncError,
          neverSynced: s.lastSyncAt === null,
        })),
        recentPayouts: payoutRows.map((p) => ({
          id: p.id,
          date: p.transactionDate.toISOString(),
          storeHandle: handleByChannelId.get(p.channelId) ?? "unknown",
          amount: Number(p.amount),
          currency: p.currency ?? "USD",
          status: p.valueDate ? "paid" : "pending",
          reconciled: p.status === "matched" || p.status === "manually_matched",
        })),
      };
    }),

    /**
     * Recent webhook events for the sync status page.
     */
    recentWebhookEvents: protectedProcedure
      .input(z.object({ limit: z.number().min(1).max(200).default(50), organizationId: z.number().int().positive().optional() }))
      .query(async ({ ctx, input }) => {
        const orgId = resolveOrgId(ctx.user, input.organizationId);

        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

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
    .input(z.object({ storeId: z.number(), organizationId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgId(ctx.user, input.organizationId);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

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
   * Import a settlement / payout file from ANY payment system.
   *
   * SHOPLINE Payments is opt-in; merchants on third-party gateways or Cash on
   * Delivery have no automatic payment leg (see bestEffortLeg). This lets them
   * supply the gateway's or courier's own CSV/XLSX export so reconciliation can
   * complete. Auto-detects the columns and accepts explicit overrides, so an
   * unfamiliar provider is still importable.
   *
   * Tenancy: the target channel is resolved SERVER-SIDE from the caller's own
   * organization. It is deliberately not a client-supplied channel code —
   * `channels.list` / `upload.createBatch` are not org-scoped, and a
   * merchant-facing upload must not be able to name another tenant's channel.
   *
   * `dryRun` returns the detected mapping and a preview without writing, so the
   * UI can have the merchant confirm the column mapping before committing.
   */
  importSettlementFile: protectedProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        /** Super-admin portal context only; validated by resolveOrgId below. */
        organizationId: z.number().int().positive().optional(),
        /** Base64 for spreadsheets, raw text for CSV. */
        content: z.string().min(1).max(14_000_000), // ~10MB decoded
        contentEncoding: z.enum(["utf8", "base64"]).default("utf8"),
        sourceLabel: z.string().min(1).max(80).default("Settlement file"),
        columnOverrides: z
          .record(
            z.enum(["orderRef", "gatewayRef", "amount", "currency", "settledAt", "fee", "description"]),
            z.string().max(200),
          )
          .optional(),
        dryRun: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Reject a tenant-supplied portal override before any database access.
      const orgId = resolveOrgId(ctx.user, input.organizationId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [store] = await db
        .select()
        .from(slConnectorStores)
        .where(and(eq(slConnectorStores.organizationId, orgId), eq(slConnectorStores.status, "active")))
        .limit(1);
      if (!store) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active SHOPLINE store for this organisation" });
      }

      const raw =
        input.contentEncoding === "base64" ? Buffer.from(input.content, "base64") : input.content;

      let parsed;
      try {
        parsed = await parseSettlementFile(raw, input.fileName);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Could not read the file",
        });
      }

      const { mapping, missingRequired } = detectColumns(parsed.headers, input.columnOverrides);

      // Preview, or a file we cannot map — either way, write nothing and tell
      // the caller exactly what was detected so they can correct it.
      if (input.dryRun || missingRequired.length > 0) {
        return {
          dryRun: true,
          committed: false,
          headers: parsed.headers,
          mapping,
          missingRequired,
          totalRows: parsed.rows.length,
          parseErrors: parsed.parseErrors,
          sampleRows: parsed.rows.slice(0, 5),
        };
      }

      const { ordersChannelId, paymentsChannelId } = await resolveChannelIds(db, orgId, store.storeHandle);

      const batchId = await createUploadBatch({
        userId: ctx.user.id,
        organizationId: orgId,
        channelId: paymentsChannelId,
        fileName: `settlement_import_${input.fileName}`,
        fileHash: null,
        detectedFormat: "settlement_file",
        totalRows: parsed.rows.length,
        validRows: 0,
        invalidRows: 0,
        status: "processing",
      });
      if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create upload batch" });

      try {
        const { rows, failures } = mapSettlementRows(parsed.rows, mapping, {
          organizationId: orgId,
          paymentsChannelId,
          batchId,
          userId: ctx.user.id,
          defaultCurrency: store.currency ?? "USD",
          sourceLabel: input.sourceLabel,
        });

        // Same idempotency guard the API path uses: re-uploading a file, or an
        // overlapping export, must not double-count settlements.
        const fresh = await rejectAlreadyIngested(db, rows, [paymentsChannelId]);
        const duplicates = rows.length - fresh.length;
        if (fresh.length > 0) await insertTransactions(fresh);

        await updateUploadBatch(batchId, {
          status: "completed",
          validRows: fresh.length,
          invalidRows: failures.length,
          completedAt: new Date(),
          errorMessage: failures.length > 0 ? failures.slice(0, 10).map((f) => `row ${f.rowIndex}: ${f.reason}`).join("; ") : null,
        });

        // Now that a payment leg exists, match it against the order book.
        let matchedCount = 0;
        let exceptionCount = 0;
        if (fresh.length > 0) {
          const dates = fresh.map((r) => (r.transactionDate as Date).getTime());
          const from = new Date(Math.min(...dates) - 3 * 24 * 60 * 60 * 1000);
          const to = new Date(Math.max(...dates) + 3 * 24 * 60 * 60 * 1000);
          const result = await runReconciliationOnPersistedData(
            db, orgId, ordersChannelId, paymentsChannelId, from, to, store.currency ?? "USD",
          );
          matchedCount = result.matchedCount;
          exceptionCount = result.exceptionCount;
        }

        // Record the operator who wrote into this tenant.
        //
        // Portal scope is what makes this necessary: before it, an import could
        // only land in the caller's OWN organisation, so the rows identified
        // their author. A super admin can now create financial transactions in
        // a merchant's ledger, and nothing on those rows says who did.
        //
        // Only on the committing path — a dry run writes nothing — and only for
        // a cross-tenant write, so a merchant importing their own settlements
        // does not fill the operator log with routine activity.
        if (input.organizationId !== undefined && orgId !== ctx.user.organizationId) {
          // The audit must not be able to fail the import.
          //
          // By this line the settlement rows and the reconciliation results are
          // already committed, and none of it is in a transaction. Letting a
          // failed audit insert reach the enclosing catch would mark the upload
          // batch `failed` and return an error for work that actually
          // succeeded — the merchant is told nothing imported while their
          // ledger says otherwise, and the obvious response is to retry.
          //
          // So the failure is made loud rather than fatal: an unattributed
          // write is recoverable from this log line, a ledger that disagrees
          // with its own status is not.
          try {
            await logPlatformEvent({
              actorId: ctx.user.id,
              actorName: ctx.user.name ?? undefined,
              eventType: "tenant_data_imported",
              targetType: "organization",
              targetId: orgId,
              targetName: store.storeHandle,
              newValue: JSON.stringify({
                fileName: input.fileName,
                sourceLabel: input.sourceLabel,
                imported: fresh.length,
                duplicates,
                failed: failures.length,
              }),
            });
          } catch (auditErr) {
            console.error(
              "[shopline-settlement] AUDIT WRITE FAILED for a committed cross-tenant import — " +
                `actor=${ctx.user.id} targetOrg=${orgId} store=${store.storeHandle} ` +
                `file=${input.fileName} imported=${fresh.length} duplicates=${duplicates} failed=${failures.length}`,
              auditErr,
            );
          }
        }

        return {
          dryRun: false,
          committed: true,
          headers: parsed.headers,
          mapping,
          missingRequired: [] as string[],
          totalRows: parsed.rows.length,
          imported: fresh.length,
          duplicates,
          failed: failures.length,
          parseErrors: parsed.parseErrors,
          sampleFailures: failures.slice(0, 5),
          matchedCount,
          exceptionCount,
        };
      } catch (err) {
        await updateUploadBatch(batchId, {
          status: "failed",
          errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
          completedAt: new Date(),
        });
        throw err;
      }
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
