/**
 * Authentication procedures — `auth.*`.
 *
 * Extracted verbatim from `server/routers.ts` (CLAUDE.md §16: split routers over
 * 150 lines; §10 tracks the wider effort). **No behaviour change**: the bodies
 * are the same code, the procedure names and their base procedures are
 * unchanged, and `authRouter` is mounted at the same key.
 *
 * The magic-link throttles move WITH the procedures because nothing else used
 * them. They are still module-level singletons, so there is still exactly one
 * cooldown map and one limiter per process — moving a file does not change
 * that, but it is the sort of thing worth saying out loud in a refactor.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { organizations } from "../../drizzle/schema";
import * as db from "../db";
import { getDb } from "../db";
import { getSessionCookieOptions } from "../_core/cookies";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { createRateLimiter } from "../rateLimiter";
import { DEMO_PREWARM_OPEN_ID, isPrewarmComplete } from "../prewarmDemoUser";
import { getClientInfo, logAudit, PUBLIC_APP_ORIGIN } from "./shared";

// In-memory throttle for self-service magic-link requests, keyed by normalised
// email. Prevents inbox flooding / abuse. Adequate for the single-process pilot
// deployment; move to a shared store (Redis) when scaling horizontally.
const magicLinkRequestCooldown = new Map<string, number>();
const MAGIC_LINK_COOLDOWN_MS = 60_000;
// PCI remediation (WS-2): per-IP companion throttle — 10 link requests per
// 15 minutes per IP, regardless of how many emails are tried.
const magicLinkIpLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

export const authRouter = router({
  // The account as it signed in — not the portal view. Inside a tenant's
  // portal `ctx.user.organizationId` is the TENANT's (server/_core/portalView.ts);
  // telling the browser the super admin now belongs to that tenant would be false.
  me: publicProcedure.query((opts) => opts.ctx.actor ?? opts.ctx.user),
  // Which enterprise SSO providers are configured (drives /login buttons).
  oauthProviders: publicProcedure.query(async () => {
    const { enabledSsoProviders } = await import("../_core/sso");
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
          const { sendLoginLinkEmail } = await import("../magicLinkService");
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
      // The account's session ended, not an action on the tenant on screen.
      await logAudit(ctx.user.id, "user_logout", "user_session", undefined, { email: ctx.user.email }, ip, ua, null);
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
      const { ensureGuestDemoOrganization } = await import("../prewarmDemoUser");
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
          const { ensureGuestDemoSeeded } = await import("../prewarmDemoUser");
          await ensureGuestDemoSeeded(fallbackUser.id, fallbackUser.organizationId ?? null);
          console.log(`[guestLogin] Fallback background seed complete for guest user ${fallbackUser.id}`);
        } catch (seedErr) {
          console.error("[guestLogin] Fallback background seed failed:", seedErr);
        }
      });
      const { sdk } = await import("../_core/sdk");
      const fallbackToken = await sdk.createSessionToken(fallbackUser.openId, {
        name: fallbackUser.name || undefined,
        expiresInMs: 24 * 60 * 60 * 1000,
      });
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, fallbackToken, { ...cookieOptions, maxAge: 24 * 60 * 60 * 1000 });
      return { success: true, user: fallbackUser };
    }

    // Happy path: issue a 24-hour session for the shared pre-warmed demo user
    const { sdk } = await import("../_core/sdk");
    const sessionToken = await sdk.createSessionToken(sharedUser.openId, {
      name: sharedUser.name || undefined,
      expiresInMs: 24 * 60 * 60 * 1000,
    });
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 24 * 60 * 60 * 1000 });
    console.log(`[guestLogin] Issued session for shared pre-warmed demo user (id=${sharedUser.id}, prewarmComplete=${isPrewarmComplete()})`);
    return { success: true, user: sharedUser };
  }),
});
