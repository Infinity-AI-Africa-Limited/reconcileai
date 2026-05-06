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
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { seedDemoData } from "./demoSeedEngine";

export const DEMO_PREWARM_OPEN_ID = "demo_prewarm_shared_user_v1";

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
