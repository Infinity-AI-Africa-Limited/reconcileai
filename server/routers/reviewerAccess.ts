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
      organizationId: z.number().int().positive().optional(),
      ttlDays: z.number().int().min(1).max(MAX_REVIEWER_LINK_TTL_DAYS).default(DEFAULT_REVIEWER_LINK_TTL_DAYS),
    }))
    .mutation(async ({ ctx, input }) => {
      const organizationId = input.organizationId ?? (await organizationIdByCode(SHOPLINE_REVIEW_ORG_CODE));
      if (!organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No organisation "${SHOPLINE_REVIEW_ORG_CODE}" exists yet. Install the app on the dev store first, or name an organisation explicitly.`,
        });
      }
      const appUrl = resolveAppUrl(ctx);
      if (!appUrl) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "APP_URL is not configured, so a reviewer link cannot be built." });
      }
      return issueReviewerLink({
        label: input.label,
        organizationId,
        ttlDays: input.ttlDays,
        createdBy: ctx.user.id,
        appUrl,
      });
    }),

  revoke: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await revokeReviewerLink(input.id);
      return { revoked: true };
    }),
});

export { reviewerLinkUrl };
