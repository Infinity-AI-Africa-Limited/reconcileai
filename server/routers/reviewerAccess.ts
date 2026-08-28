/**
 * Super-admin management of external reviewer sign-in links.
 *
 * Issuing one of these grants a real session in the production application, so
 * every procedure here is `superAdminProcedure` — never `adminProcedure`. A
 * tenant's own admin has no business minting an identity inside their tenant
 * that bypasses the invite flow, and this is exactly the kind of capability that
 * looks harmless until it is reachable by the wrong role.
 *
 * The containment that makes the issued link safe lives in reviewerAccess.ts and
 * _core/trpc.ts, not here. This is the operator's console over it.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { ENV } from "../_core/env";
import { superAdminProcedure } from "./shared";
import {
  DEFAULT_REVIEWER_LINK_TTL_DAYS,
  MAX_REVIEWER_LINK_TTL_DAYS,
  SHOPLINE_REVIEW_ORG_CODE,
  issueReviewerLink,
  listReviewerLinks,
  organizationIdByCode,
  platformHomeOrganizationId,
  blockingRealTenants,
  platformScopeIsSafe,
  revokeReviewerLink,
  reviewerLinkUrl,
} from "../reviewerAccess";

/**
 * The origin the link is built on.
 *
 * APP_URL is the canonical answer; falling back to the request's own host keeps
 * a link usable on a deployment where it is unset, rather than handing the
 * operator a URL beginning "undefined" that they then paste into an App Store
 * submission.
 */
function resolveAppUrl(ctx: { req?: { headers?: Record<string, unknown>; protocol?: string } }): string {
  if (ENV.appUrl) return ENV.appUrl;
  const headers = ctx.req?.headers ?? {};
  const proto = (headers["x-forwarded-proto"] as string) || ctx.req?.protocol || "https";
  const host = (headers["x-forwarded-host"] as string) || (headers.host as string) || "";
  return host ? `${proto}://${host}` : "";
}

export const reviewerAccessRouter = router({
  /** Existing links, newest first. Tokens are never re-shown — only the issue call returns a URL. */
  list: superAdminProcedure.query(async () => {
    const links = await listReviewerLinks();
    return links.map((link) => ({
      ...link,
      isActive: !link.revokedAt && link.expiresAt.getTime() > Date.now(),
    }));
  }),

  /**
   * Issue a link. Defaults to the SHOPLINE dev-store retail tenant, which is the
   * one an App Store reviewer needs to see; any organisation can be named.
   */
  issue: superAdminProcedure
    .input(z.object({
      label: z.string().min(1).max(120),
      scope: z.enum(["tenant", "platform"]).default("tenant"),
      organizationId: z.number().int().positive().optional(),
      ttlDays: z.number().int().min(1).max(MAX_REVIEWER_LINK_TTL_DAYS).default(DEFAULT_REVIEWER_LINK_TTL_DAYS),
    }))
    .mutation(async ({ ctx, input }) => {
      // A platform link is cross-tenant, so it has no tenant of its own; it is
      // filed against the operator's organisation purely so the identity has a
      // home. A tenant link defaults to the SHOPLINE dev store.
      const organizationId = input.organizationId
        ?? (input.scope === "platform"
          ? await platformHomeOrganizationId()
          : await organizationIdByCode(SHOPLINE_REVIEW_ORG_CODE));

      if (!organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: input.scope === "platform"
            ? "No super-admin organisation exists to anchor a platform reviewer link."
            : `No organisation "${SHOPLINE_REVIEW_ORG_CODE}" exists yet. Install the app on the dev store first, or name an organisation explicitly.`,
        });
      }
      const appUrl = resolveAppUrl(ctx);
      if (!appUrl) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "APP_URL is not configured, so a reviewer link cannot be built." });
      }
      return issueReviewerLink({
        label: input.label,
        scope: input.scope,
        organizationId,
        ttlDays: input.ttlDays,
        createdBy: ctx.user.id,
        appUrl,
      });
    }),

  /**
   * Whether a platform-wide link could be issued right now, and why not.
   *
   * Surfaced so the operator sees the condition before clicking rather than as a
   * refusal afterwards — and so the reason is legible: this is the first-customer
   * gate, not a malfunction.
   */
  platformScopeStatus: superAdminProcedure.query(async () => {
    const SHOWN = 10;
    // One extra row distinguishes a complete list from a truncated one.
    const blocking = await blockingRealTenants(SHOWN + 1);
    return {
      available: blocking.length === 0,
      // Named, not just counted. The operator has to be able to act on this
      // without asking an engineer which row it means.
      blocking: blocking.slice(0, SHOWN).map((o) => ({ id: o.id, code: o.code, name: o.name })),
      truncated: blocking.length > SHOWN,
      reason: blocking.length === 0
        ? null
        : "Platform-wide links are withheld while an organisation is not marked as a demo, so a real tenant's data cannot be exposed.",
    };
  }),

  revoke: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await revokeReviewerLink(input.id);
      return { revoked: true };
    }),
});

export { reviewerLinkUrl };
