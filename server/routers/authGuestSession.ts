/**
 * Establishing a guest demo session.
 *
 * Lifted out of `auth.guestLogin` so that `routers/auth.ts` stays a router:
 * this is 70-odd lines of demo-tenant provisioning and cold-start recovery,
 * which is a service concern rather than a routing one (CLAUDE.md §16 — the
 * 150-line rule; raised by Greptile on PR #152).
 *
 * The logic is unchanged from `routers.ts`, verbatim, including the cold-start
 * fallback and the reasons it is shaped the way it is.
 */
import { TRPCError } from "@trpc/server";
import type { Request, Response } from "express";
import { COOKIE_NAME } from "@shared/const";
import * as db from "../db";
import { getSessionCookieOptions } from "../_core/cookies";
import { DEMO_PREWARM_OPEN_ID, isPrewarmComplete } from "../prewarmDemoUser";

/** A guest session lasts a day; long enough to walk the demo, short enough to expire. */
const GUEST_SESSION_MS = 24 * 60 * 60 * 1000;

export async function establishGuestSession(ctx: { req: Request; res: Response }) {
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
}
