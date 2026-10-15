/**
 * Outbound webhooks: register, list, delete, and the delivery dashboard.
 *
 * A webhook belongs to ONE organisation, receives only that organisation's
 * events (server/webhookDelivery.ts), and is managed by that organisation's
 * admins. Three rules live here, each enforced on the server because the page
 * that offers the action is not a boundary:
 *
 *   - admin only. `adminProcedure`, not `guestProtectedProcedure`: the
 *     Integrations page is admin-only (navItems.ts), and the procedures behind
 *     it accepted any member — the read-only CFO and Compliance roles included
 *     — who could then point the organisation's events at any URL, or read the
 *     URLs, which can hold tokens;
 *   - a destination the server may reach (server/outboundDestination.ts),
 *     refused here when it points inside a network, and checked again at
 *     every delivery, because DNS can change;
 *   - at most MAX_ACTIVE_WEBHOOKS_PER_ORG active webhooks, held under a row
 *     lock (db.createWebhookWithinLimit), since each is a request per event.
 */
import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isTenantId } from "@shared/tenantId";
import { WEBHOOK_SUBSCRIPTIONS, type WebhookSubscription } from "@shared/webhookEvents";
import { router } from "../_core/trpc";
import * as db from "../db";
import { destinationPolicy, registrationProblem } from "../outboundDestination";
import { deliveryStats, listDeliveries } from "../webhookDelivery";
import { MAX_NAME_LENGTH, adminProcedure, getClientInfo, logAudit, sanitizeInput } from "./shared";

/** Ceiling on one organisation's active webhooks: each is a request per event. */
export const MAX_ACTIVE_WEBHOOKS_PER_ORG = 25;

const SUBSCRIPTIONS = WEBHOOK_SUBSCRIPTIONS as [WebhookSubscription, ...WebhookSubscription[]];

/** The caller's organisation, or a refusal: a webhook must belong to one. */
function requireTenant(organizationId: number | null | undefined): number {
  if (!isTenantId(organizationId)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your account is not linked to an organization" });
  }
  return organizationId;
}

export const webhooksRouter = router({
  // The organisation's webhooks — the set its events reach, and the set
  // `delete` can act on. Was per user, so a colleague's webhook receiving the
  // organisation's events was invisible while still deletable.
  list: adminProcedure.query(async ({ ctx }) => {
    const tenant = ctx.user.organizationId;
    return isTenantId(tenant) ? db.getWebhooks(tenant) : [];
  }),

  create: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(MAX_NAME_LENGTH),
      url: z.string().url().max(2000),
      events: z.array(z.enum(SUBSCRIPTIONS)).min(1).max(SUBSCRIPTIONS.length),
    }))
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);
      // The organisation whose events this webhook will receive. An account
      // with no organisation is refused: its webhook would belong to no one.
      const organizationId = requireTenant(ctx.user.organizationId);

      // The server will POST to this URL. Refused now when it points inside a
      // network (a private, loopback or metadata address, an internal name).
      const refused = await registrationProblem(input.url, destinationPolicy());
      if (refused) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Webhook URL refused: ${refused}` });
      }

      const events = Array.from(new Set(input.events));
      const secret = crypto.randomBytes(32).toString("hex");
      const outcome = await db.createWebhookWithinLimit(
        {
          organizationId,
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          url: input.url,
          secret,
          // The array itself: the column is JSON, and drizzle serialises it.
          // `JSON.stringify` here stored a JSON *string*, which dispatch reads
          // as no subscriptions, so no webhook created here ever fired.
          events,
          isActive: true,
        },
        MAX_ACTIVE_WEBHOOKS_PER_ORG,
      );
      if (outcome.status === "limit_reached") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `An organisation can have at most ${MAX_ACTIVE_WEBHOOKS_PER_ORG} active webhooks. Delete one first.`,
        });
      }
      if (outcome.status === "no_organization") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your organization could not be found" });
      }

      // The host, not the URL: a webhook URL's path can carry a token.
      await logAudit(ctx.user.id, "create_webhook", "webhook", outcome.id, {
        name: input.name,
        host: new URL(input.url).hostname,
        events,
      }, ip, ua);
      return { id: outcome.id, secret }; // Return secret only on creation
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);
      const removed = await db.deleteWebhook(input.id, requireTenant(ctx.user.organizationId));
      if (removed === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
      await logAudit(ctx.user.id, "delete_webhook", "webhook", input.id, {}, ip, ua);
      return { success: true };
    }),

  // WS-4 delivery dashboard: recent tracked deliveries for this org's
  // webhooks, and the reliability figure (≥99.5% success criterion).
  deliveries: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const tenant = ctx.user.organizationId;
      return isTenantId(tenant) ? listDeliveries(tenant, input?.limit ?? 50) : [];
    }),

  deliveryStats: adminProcedure
    .input(z.object({ sinceDays: z.number().int().min(1).max(365).default(30) }).optional())
    .query(async ({ ctx, input }) => {
      const tenant = ctx.user.organizationId;
      if (!isTenantId(tenant)) return { total: 0, delivered: 0, failed: 0, pending: 0, reliability: null };
      return deliveryStats(tenant, input?.sinceDays ?? 30);
    }),
});
