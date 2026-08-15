/**
 * Pre-warm Demo User Service — ReconcileAI
 *
 * Creates a single permanent "demo" user account on server boot and seeds it
 * with FMCG + FinServ demo data exactly once.  Every guest login then reuses
 * this shared account so the first visitor gets instant data instead of
 * waiting 30–60 s for background seeding.
 *
 * The shared user is identified by the fixed openId DEMO_PREWARM_OPEN_ID.
 * It is never exposed to real users — guests receive a short-lived session
 * token scoped to this account, but the account itself is not discoverable
 * through the normal OAuth flow.
 */

import { getDb } from "./db";
import { organizations, users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { seedDemoData } from "./demoSeedEngine";

export const DEMO_PREWARM_OPEN_ID = "demo_prewarm_shared_user_v1";
/** Stable code for the organisation every guest-demo account belongs to. */
export const GUEST_DEMO_ORG_CODE = "RECONCILEAI_GUEST_DEMO";

/**
 * The organisation guest-demo accounts belong to, created on first use.
 *
 * Guests previously had NO organisation, and everything the demo seeded for
 * them — jobs, transactions, matches, exceptions, batches, channels — was
 * written with `organizationId = null`. Org-less is not "private": it is a
 * SHARED scope. `orgFilter(col, null)` resolves to `IS NULL`, so every org-less
 * account reads every other org-less account's rows, the eight demo rails
 * collapsed onto one unsuffixed set of channel codes shared between them, and
 * the 22 real accounts that happen to have no organisation would have seen the
 * guest demo data too.
 *
 * Giving the demo path a real tenant fixes all of that at the root rather than
 * patching each read. It also restores agent memory for guests, which had to be
 * skipped while there was no tenant that could read it back.
 *
 * Flagged `isDemo`, so the SLA monitor and anything else that must not treat
 * fabricated data as real skips it automatically.
 */
export async function ensureGuestDemoOrganization(): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.code, GUEST_DEMO_ORG_CODE))
    .limit(1);
  if (existing) return existing.id;

  await db.insert(organizations).values({
    name: "ReconcileAI Guest Demo",
    code: GUEST_DEMO_ORG_CODE,
    // Guests are shown both the FMCG and the financial-services datasets, so no
    // single vertical is honest here. financial_services is the closer fit for
    // what a guest is most likely to be evaluating, and isDemo keeps it out of
    // anything that reasons about real tenants.
    segment: "financial_services",
    isDemo: true,
  });
  const [created] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.code, GUEST_DEMO_ORG_CODE))
    .limit(1);
  return created?.id ?? null;
}

let _prewarmComplete = false;
let _prewarmUserId: number | null = null;
let _prewarmOrgId: number | null = null;
let _prewarmInProgress = false;

export function isPrewarmComplete(): boolean {
  return _prewarmComplete;
}

export function getPrewarmUserId(): number | null {
  return _prewarmUserId;
}

export function getPrewarmOrgId(): number | null {
  return _prewarmOrgId;
}

/**
 * Seed the shared guest demo tenant, at most once, however many callers race.
 *
 * A plain `if (empty) seed()` is check-then-act, and the fallback path runs
 * precisely at COLD START — the one moment several guests are most likely to
 * arrive together, because a demo link has just been shared. Both callbacks read
 * an empty tenant, both seed, and since each seed wipes only its OWN userId the
 * tenant keeps both copies. Every figure in the demo doubles.
 *
 * Concurrent callers are collapsed onto one in-flight promise, and the emptiness
 * check is re-run inside it so a caller that queued behind a completed seed does
 * not seed again. Same shape as `_prewarmInProgress` below, which exists for
 * exactly this reason.
 *
 * ⚠️ PER-PROCESS. Two Railway instances cold-starting together could still each
 * seed once. That is the same limitation the SHOPLINE realtime debounce carries
 * (CLAUDE.md §2B.7) and it has the same answer — a shared lock once REDIS_URL is
 * provisioned. Acceptable today because the platform runs a single instance, and
 * the failure mode is duplicated DEMO data rather than anything a tenant owns.
 */
let _guestSeedInFlight: Promise<void> | null = null;

export async function ensureGuestDemoSeeded(userId: number, organizationId: number | null): Promise<void> {
  if (_guestSeedInFlight) {
    await _guestSeedInFlight;
    return;
  }
  _guestSeedInFlight = (async () => {
    const db = await getDb();
    if (!db) return;
    const { reconciliationJobs } = await import("../drizzle/schema");
    const { orgFilter } = await import("./db");
    // Re-checked INSIDE the critical section. A caller that arrived while the
    // first seed was running would otherwise proceed on a stale reading.
    const existing = await db
      .select({ id: reconciliationJobs.id })
      .from(reconciliationJobs)
      .where(orgFilter(reconciliationJobs.organizationId, organizationId))
      .limit(1);
    if (existing.length > 0) {
      console.log("[guest-demo] Tenant already seeded — reusing it");
      return;
    }
    await seedDemoData(userId, organizationId);
    const { seedFinServDemoData } = await import("./demoSeedFinServ");
    await seedFinServDemoData(userId, organizationId, "both");
    console.log(`[guest-demo] Seeded shared demo tenant ${organizationId} via user ${userId}`);
  })();

  try {
    await _guestSeedInFlight;
  } finally {
    // Cleared so a later deactivation can be followed by a fresh seed.
    _guestSeedInFlight = null;
  }
}

/**
 * Ensure the shared demo user exists and has seeded data.
 * Safe to call multiple times — idempotent after first success.
 */
export async function prewarmDemoUser(): Promise<void> {
  if (_prewarmComplete || _prewarmInProgress) return;
  _prewarmInProgress = true;

  try {
    const db = await getDb();
    if (!db) {
      console.warn("[Prewarm] Database not available — skipping pre-warm");
      return;
    }

    // ── 0. The tenant the demo data belongs to ─────────────────────────
    const guestOrgId = await ensureGuestDemoOrganization();

    // ── 1. Ensure the shared demo user row exists ──────────────────────
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.openId, DEMO_PREWARM_OPEN_ID))
      .limit(1);

    let demoUser = existing[0];

    if (!demoUser) {
      console.log("[Prewarm] Creating shared demo user…");
      await db.insert(users).values({
        openId: DEMO_PREWARM_OPEN_ID,
        name: "Demo User",
        email: "demo@reconcileai.internal",
        role: "user",
        isGuest: true,
        organizationId: guestOrgId,
        lastSignedIn: new Date(),
      });
      const created = await db
        .select()
        .from(users)
        .where(eq(users.openId, DEMO_PREWARM_OPEN_ID))
        .limit(1);
      demoUser = created[0];
    }

    if (!demoUser) {
      console.error("[Prewarm] Failed to create shared demo user");
      return;
    }

    // Adopt the demo organisation on an EXISTING shared user too. The account is
    // long-lived and predates this change, so without the backfill the deployed
    // prewarm user would keep seeding into the org-less shared scope forever.
    if (!demoUser.organizationId && guestOrgId) {
      await db.update(users).set({ organizationId: guestOrgId }).where(eq(users.id, demoUser.id));
      demoUser = { ...demoUser, organizationId: guestOrgId };
      console.log(`[Prewarm] Adopted guest demo organisation ${guestOrgId} for shared demo user`);
    }

    _prewarmUserId = demoUser.id;
    _prewarmOrgId = demoUser.organizationId ?? null;

    // ── 2. Check whether data is already seeded ────────────────────────
    const { reconciliationJobs } = await import("../drizzle/schema");
    const existingJobs = await db
      .select()
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.userId, demoUser.id))
      .limit(1);

    if (existingJobs.length > 0) {
      console.log(
        `[Prewarm] Shared demo user (id=${demoUser.id}) already has seeded data — skipping seed`
      );
      _prewarmComplete = true;
      return;
    }

    // ── 3. Seed FMCG + FinServ data ────────────────────────────────────
    console.log(
      `[Prewarm] Seeding FMCG + FinServ demo data for shared user id=${demoUser.id}…`
    );

    await seedDemoData(demoUser.id, demoUser.organizationId ?? null);

    const { seedFinServDemoData } = await import("./demoSeedFinServ");
    await seedFinServDemoData(
      demoUser.id,
      demoUser.organizationId ?? null,
      "both"
    );

    _prewarmComplete = true;
    console.log("[Prewarm] ✓ Shared demo user pre-warm complete");
  } catch (err) {
    console.error("[Prewarm] Pre-warm failed:", err);
  } finally {
    _prewarmInProgress = false;
  }
}
