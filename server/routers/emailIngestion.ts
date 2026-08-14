/**
 * Email-forward ingestion (Tier A) — tRPC surface.
 *
 * Completes the transport whose security model shipped in #36 and whose inbound
 * handler shipped in #37. Neither did anything until a source existed; this is
 * how one gets created.
 *
 * Two properties are load-bearing here and are asserted by tests:
 *
 *   1. The address token is generated SERVER-SIDE, from a CSPRNG, and is never
 *      accepted from the client. It is the first of the two controls guarding
 *      the only endpoint where an unauthenticated stranger can hand us a file;
 *      a caller-chosen token would let anyone mint `settle-payouts@…` and then
 *      guess it. There is deliberately no input field for it anywhere.
 *
 *   2. An allow-list is REQUIRED and is validated through the same parser the
 *      inbound path enforces with. The enforcer fails closed on an empty list,
 *      so a source saved without one would accept nothing while appearing
 *      configured — the silent-nothing failure that is far harder to notice
 *      than an outright error.
 *
 * Org scoping follows the bucket sibling: every id-keyed procedure resolves
 * through ownedSource(), which filters on organizationId and throws NOT_FOUND
 * whether the row is missing or another tenant's, so it cannot be used to
 * enumerate. That pattern is retrofitted onto SFTP in #32 and ratcheted in #34;
 * written in from the first line is cheaper than either.
 */
import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { emailIngestionSources, emailIngestionLogs } from "../../drizzle/schema";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { ENV } from "../_core/env";
import { assertChannelBindable } from "./shared";
import { validateAllowlist } from "../ingest/senderAllowlist";

/** Bounds for the pre-download size cap. A cap of "1 byte" is a footgun. */
const MIN_ATTACHMENT_BYTES = 1_048_576; // 1 MB
const MAX_ATTACHMENT_BYTES = 52_428_800; // 50 MB

/** The caller's organization, or a hard failure. Mail feeds are institutional. */
function requireOrg(user: { organizationId?: number | null }): number {
  if (!user.organizationId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is not linked to an organization",
    });
  }
  return user.organizationId;
}

/**
 * A fresh, unguessable address token.
 *
 * 128 bits of CSPRNG output, lowercase hex — which is also exactly what the
 * inbound handler's `settle-([a-z0-9]{8,64})@` will match. A token this size
 * makes the unique index on addressToken a formality rather than a race worth
 * retrying against.
 */
export function generateAddressToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The address a merchant forwards to, or null when inbound mail is not
 * configured on this deployment.
 *
 * Null rather than a half-formed string on purpose: an address printed without
 * a domain would be copied into a mail rule and silently drop every message.
 */
export function forwardingAddress(token: string, domain = ENV.emailInboundDomain): string | null {
  return domain ? `settle-${token}@${domain}` : null;
}

/**
 * How ready inbound mail actually is.
 *
 *   unconfigured — the deployment cannot receive; the endpoint fails closed.
 *   unproven     — configured, but nothing has EVER arrived. Not an error, and
 *                  not success either: on this deployment it is the true state
 *                  of a channel whose domain was never registered for receiving
 *                  (CLAUDE.md §19.4). Reported distinctly so it can never be
 *                  demoed or sold on the strength of a green screen.
 *   receiving    — a delivery has landed, so the whole path is proven.
 */
export type InboundReadiness = "unconfigured" | "unproven" | "receiving";

export function inboundReadiness(
  domainConfigured: boolean,
  webhookSecretConfigured: boolean,
  everReceived: boolean,
): InboundReadiness {
  if (!domainConfigured || !webhookSecretConfigured) return "unconfigured";
  return everReceived ? "receiving" : "unproven";
}

/**
 * Load a source and prove the caller's org owns it.
 * NOT_FOUND whether it is missing or someone else's — the distinction would be
 * an enumeration oracle.
 */
async function ownedSource(user: { organizationId?: number | null }, id: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [src] = await db
    .select()
    .from(emailIngestionSources)
    .where(and(eq(emailIngestionSources.id, id), eq(emailIngestionSources.organizationId, requireOrg(user))))
    .limit(1);
  if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Email source not found" });
  return { db, src };
}

/** Validate an allow-list, or fail with something the user can act on. */
function requireValidAllowlist(raw: string): void {
  const result = validateAllowlist(raw);
  if (result.ok) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      result.invalid.length > 0
        ? `Not a valid sender or domain: ${result.invalid.join(", ")}`
        : "At least one allowed sender is required — an empty list accepts nothing",
  });
}

export const emailIngestionRouter = router({
  /**
   * Whether this deployment can actually receive mail.
   *
   * Booleans only — never the secret itself.
   *
   * ── Why env presence is NOT the signal ──────────────────────────────────────
   * Both env vars are already set in production, yet no mail arrives: Resend's
   * free plan allows one domain and the root domain holds the slot, so the
   * inbound subdomain was never registered for receiving (CLAUDE.md §19.4).
   * A banner keyed on configuration alone would therefore read green on a
   * channel that has never received anything — the precise "looks configured,
   * ingests nothing" failure this codebase keeps having to design against, and
   * the one §19.4 explicitly instructs this surface not to repeat.
   *
   * So readiness is keyed on EVIDENCE: has any delivery ever landed. The check
   * is deliberately platform-wide rather than org-scoped, because a delivery to
   * an unrecognised address carries no organizationId and is nonetheless the
   * proof that MX → Resend → webhook → signature → database works end to end.
   * Only a boolean crosses the boundary, never another tenant's volume.
   */
  inboundStatus: protectedProcedure.query(async () => {
    const domainConfigured = Boolean(ENV.emailInboundDomain);
    const webhookSecretConfigured = Boolean(ENV.resendWebhookSecret);

    const db = await getDb();
    let everReceived = false;
    if (db) {
      const [row] = await db.select({ id: emailIngestionLogs.id }).from(emailIngestionLogs).limit(1);
      everReceived = Boolean(row);
    }

    return {
      domain: ENV.emailInboundDomain || null,
      domainConfigured,
      webhookSecretConfigured,
      everReceived,
      readiness: inboundReadiness(domainConfigured, webhookSecretConfigured, everReceived),
    };
  }),

  /** Sources for the caller's organization. Never another tenant's. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const rows = await db
      .select()
      .from(emailIngestionSources)
      .where(eq(emailIngestionSources.organizationId, requireOrg(ctx.user)))
      .orderBy(desc(emailIngestionSources.createdAt));
    // The token is not key material to withhold — it IS the address, and the
    // admin cannot configure forwarding without seeing it.
    return rows.map((r) => ({ ...r, address: forwardingAddress(r.addressToken) }));
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        channelId: z.number().int().positive(),
        // Required, not optional-with-a-default. See the header.
        allowedSenders: z.string().min(1).max(4000),
        maxAttachmentBytes: z
          .number()
          .int()
          .min(MIN_ATTACHMENT_BYTES)
          .max(MAX_ATTACHMENT_BYTES)
          .default(10_485_760),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const organizationId = requireOrg(ctx.user);

      requireValidAllowlist(input.allowedSenders);
      await assertChannelBindable(organizationId, input.channelId);

      const addressToken = generateAddressToken();
      const [res] = await db.insert(emailIngestionSources).values({
        organizationId,
        userId: ctx.user.id,
        name: input.name,
        addressToken,
        allowedSenders: input.allowedSenders,
        channelId: input.channelId,
        maxAttachmentBytes: input.maxAttachmentBytes,
        isActive: true,
      });
      return { id: res.insertId, addressToken, address: forwardingAddress(addressToken) };
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        channelId: z.number().int().positive().optional(),
        allowedSenders: z.string().min(1).max(4000).optional(),
        maxAttachmentBytes: z.number().int().min(MIN_ATTACHMENT_BYTES).max(MAX_ATTACHMENT_BYTES).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, src } = await ownedSource(ctx.user, input.id);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.maxAttachmentBytes !== undefined) patch.maxAttachmentBytes = input.maxAttachmentBytes;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.allowedSenders !== undefined) {
        // Re-validated on every edit: narrowing a working list to nothing must
        // fail loudly here rather than silently at the next delivery.
        requireValidAllowlist(input.allowedSenders);
        patch.allowedSenders = input.allowedSenders;
      }
      if (input.channelId !== undefined) {
        await assertChannelBindable(src.organizationId, input.channelId);
        patch.channelId = input.channelId;
      }

      await db.update(emailIngestionSources).set(patch).where(eq(emailIngestionSources.id, src.id));
      return { success: true };
    }),

  /**
   * Issue a new address, invalidating the old one immediately.
   *
   * The response to a leak, and the reason the two controls are separate.
   * Addresses end up in mail rules, shared inboxes, support tickets and
   * screenshots; when one gets out, the allow-list is what held the line and
   * this is what closes it. Mail to the old address stops resolving on the next
   * delivery — which is the point, so the UI says so before asking.
   */
  rotateAddress: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const { db, src } = await ownedSource(ctx.user, input.id);
      const addressToken = generateAddressToken();
      await db
        .update(emailIngestionSources)
        .set({ addressToken })
        .where(eq(emailIngestionSources.id, src.id));
      return { addressToken, address: forwardingAddress(addressToken) };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const { db, src } = await ownedSource(ctx.user, input.id);
      await db.delete(emailIngestionSources).where(eq(emailIngestionSources.id, src.id));
      return { success: true };
    }),

  /**
   * Delivery history — accepted AND refused.
   *
   * The rejections are the more valuable half: a run of `sender_not_allowed` on
   * a source is how a leaked address announces itself. Deliveries to an address
   * matching no source carry no organizationId by design, so they are
   * platform-level evidence and correctly invisible here.
   */
  logs: protectedProcedure
    .input(
      z.object({
        sourceId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // Both predicates AND-ed into ONE where(). Chaining .where() in drizzle
      // REPLACES rather than combines — exactly how the SFTP log reader ended
      // up returning every tenant's history (#32).
      const conditions = [eq(emailIngestionLogs.organizationId, requireOrg(ctx.user))];
      if (input.sourceId) conditions.push(eq(emailIngestionLogs.emailSourceId, input.sourceId));
      return db
        .select()
        .from(emailIngestionLogs)
        .where(and(...conditions))
        .orderBy(desc(emailIngestionLogs.createdAt))
        .limit(input.limit);
    }),
});
