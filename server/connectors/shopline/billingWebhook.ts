/**
 * SHOPLINE Billing Webhook Handler
 *
 * Processes subscription lifecycle events from the SHOPLINE App Store:
 * - app_plan/activated → merchant subscribed to a plan (or trial started)
 * - app_plan/expired → subscription expired or cancelled
 * - billing_attempts/succeed → monthly billing collected successfully
 * - billing_attempts/fail → billing attempt failed (grace period)
 * - app/installation_status_changed → app installed/uninstalled
 *
 * These webhooks are registered in the SHOPLINE Partner Portal (not via API).
 * The APP Secret is used as the HMAC signing key for verification.
 */
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import {
  slConnectorSubscriptions,
  slConnectorStores,
} from "../../../drizzle/connector_schema";
import {
  TIER_1_FREE_TRIAL_DAYS,
  TIER_1_GRACE_PERIOD_DAYS,
  TIER_1_SUBSCRIPTION_BANDS,
  type SubscriptionBandId,
} from "../../../shared/shoplineConstants";

const DAY_MS = 24 * 60 * 60 * 1000;
/** now + TIER_1_GRACE_PERIOD_DAYS — the buffer end after a failed renewal/expiry. */
function graceDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + TIER_1_GRACE_PERIOD_DAYS * DAY_MS);
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ─── Webhook Payload Interfaces ──────────────────────────────────────────────

interface AppPlanActivatedPayload {
  /** SHOPLINE subscription/charge ID */
  id?: string;
  subscription_id?: string;
  /** Plan spuKey that was activated */
  plan_key?: string;
  spu_key?: string;
  /** Whether this is a trial activation */
  is_trial?: boolean;
  trial?: boolean;
  /** Store/shop info */
  shop_id?: string;
  store_id?: string;
}

interface AppPlanExpiredPayload {
  id?: string;
  subscription_id?: string;
  plan_key?: string;
  spu_key?: string;
  shop_id?: string;
  store_id?: string;
  reason?: string;
}

interface BillingAttemptPayload {
  id?: string;
  subscription_id?: string;
  plan_key?: string;
  spu_key?: string;
  shop_id?: string;
  store_id?: string;
  /** Billing period */
  period_start?: string;
  period_end?: string;
  /** Failure reason (only for billing_attempts/fail) */
  failure_reason?: string;
  error_message?: string;
}

interface InstallationStatusPayload {
  shop_id?: string;
  store_id?: string;
  /** "installed" | "uninstalled" */
  status?: string;
  action?: string;
}

// ─── Handler Functions ───────────────────────────────────────────────────────

/**
 * Handle app_plan/activated webhook.
 * Creates or updates the subscription record for the store.
 */
export async function handlePlanActivated(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: AppPlanActivatedPayload,
): Promise<void> {
  const subscriptionId = payload.subscription_id || payload.id || null;
  const planKey = (payload.spu_key || payload.plan_key || "starter") as SubscriptionBandId;
  const isTrial = payload.is_trial ?? payload.trial ?? true; // default to trial on first activation

  // Validate planKey exists in our bands
  const band = TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === planKey);
  if (!band) {
    console.warn(`[SHOPLINE Billing] Unknown plan key: ${planKey}, defaulting to starter`);
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + TIER_1_FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);

  // Upsert subscription record
  const [existing] = await db
    .select()
    .from(slConnectorSubscriptions)
    .where(eq(slConnectorSubscriptions.slStoreId, slStoreId))
    .limit(1);

  if (existing) {
    await db
      .update(slConnectorSubscriptions)
      .set({
        shoplineSubscriptionId: subscriptionId,
        planId: planKey,
        status: isTrial ? "trialing" : "active",
        trialStartedAt: isTrial ? now : existing.trialStartedAt,
        trialEndsAt: isTrial ? trialEnd : existing.trialEndsAt,
        activatedAt: isTrial ? null : now,
        cancelledAt: null,
        graceEndsAt: null, // back in good standing — clear any grace buffer
        failedBillingAttempts: 0,
        lastFailureReason: null,
      })
      .where(eq(slConnectorSubscriptions.id, existing.id));
  } else {
    await db.insert(slConnectorSubscriptions).values({
      organizationId,
      slStoreId,
      shoplineSubscriptionId: subscriptionId,
      planId: planKey,
      status: isTrial ? "trialing" : "active",
      trialStartedAt: isTrial ? now : null,
      trialEndsAt: isTrial ? trialEnd : null,
      activatedAt: isTrial ? null : now,
      failedBillingAttempts: 0,
    });
  }

  console.info(
    `[SHOPLINE Billing] Plan activated: store=${slStoreId}, plan=${planKey}, trial=${isTrial}`,
  );
}

/**
 * Handle app_plan/expired webhook.
 * Marks the subscription as expired/cancelled.
 */
export async function handlePlanExpired(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: AppPlanExpiredPayload,
): Promise<void> {
  const now = new Date();

  // Expiry starts the grace buffer — the merchant keeps access for
  // TIER_1_GRACE_PERIOD_DAYS while they resolve, then the sync gate cuts off.
  // Preserve an already-running grace deadline so a later expiry event can't
  // extend the buffer.
  const [existing] = await db
    .select({ graceEndsAt: slConnectorSubscriptions.graceEndsAt })
    .from(slConnectorSubscriptions)
    .where(
      and(
        eq(slConnectorSubscriptions.slStoreId, slStoreId),
        eq(slConnectorSubscriptions.organizationId, organizationId),
      ),
    )
    .limit(1);

  await db
    .update(slConnectorSubscriptions)
    .set({
      status: "expired",
      cancelledAt: now,
      graceEndsAt: existing?.graceEndsAt ?? graceDeadline(now),
    })
    .where(
      and(
        eq(slConnectorSubscriptions.slStoreId, slStoreId),
        eq(slConnectorSubscriptions.organizationId, organizationId),
      ),
    );

  console.info(
    `[SHOPLINE Billing] Plan expired: store=${slStoreId}, reason=${payload.reason || "unknown"}, grace ends ${(existing?.graceEndsAt ?? graceDeadline(now)).toISOString()}`,
  );
}

/**
 * Handle billing_attempts/succeed webhook.
 * Confirms the subscription is active and resets failure counters.
 */
export async function handleBillingSuccess(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: BillingAttemptPayload,
): Promise<void> {
  const periodStart = payload.period_start ? new Date(payload.period_start) : new Date();
  const periodEnd = payload.period_end ? new Date(payload.period_end) : null;

  await db
    .update(slConnectorSubscriptions)
    .set({
      status: "active",
      activatedAt: new Date(), // re-confirm activation
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      graceEndsAt: null, // successful charge clears any grace buffer
      failedBillingAttempts: 0,
      lastFailureReason: null,
    })
    .where(
      and(
        eq(slConnectorSubscriptions.slStoreId, slStoreId),
        eq(slConnectorSubscriptions.organizationId, organizationId),
      ),
    );

  console.info(`[SHOPLINE Billing] Billing succeeded: store=${slStoreId}`);
}

/**
 * Handle billing_attempts/fail webhook.
 * Increments failure counter and marks as past_due after threshold.
 */
export async function handleBillingFailure(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: BillingAttemptPayload,
): Promise<void> {
  const failureReason = payload.failure_reason || payload.error_message || "Unknown billing failure";

  const [existing] = await db
    .select()
    .from(slConnectorSubscriptions)
    .where(
      and(
        eq(slConnectorSubscriptions.slStoreId, slStoreId),
        eq(slConnectorSubscriptions.organizationId, organizationId),
      ),
    )
    .limit(1);

  const attempts = (existing?.failedBillingAttempts ?? 0) + 1;
  // After 3 failed attempts, mark as past_due (SHOPLINE may cancel after their
  // own threshold); before that, preserve whatever status the row already had.
  const goesPastDue = attempts >= 3;
  const newStatus = goesPastDue ? "past_due" : (existing?.status ?? "active");
  // Entering past_due starts the grace buffer (once) — keep an existing deadline
  // so repeated failures don't extend it.
  const graceEndsAt = goesPastDue
    ? ((existing?.graceEndsAt as Date | null | undefined) ?? graceDeadline())
    : (existing?.graceEndsAt as Date | null | undefined) ?? null;

  await db
    .update(slConnectorSubscriptions)
    .set({
      status: newStatus,
      graceEndsAt,
      failedBillingAttempts: attempts,
      lastFailureReason: failureReason,
    })
    .where(
      and(
        eq(slConnectorSubscriptions.slStoreId, slStoreId),
        eq(slConnectorSubscriptions.organizationId, organizationId),
      ),
    );

  console.warn(
    `[SHOPLINE Billing] Billing failed: store=${slStoreId}, attempts=${attempts}, reason=${failureReason}`,
  );
}

/**
 * Handle app/installation_status_changed webhook.
 * Updates the store status when app is uninstalled.
 */
export async function handleInstallationStatusChanged(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: InstallationStatusPayload,
): Promise<void> {
  const action = payload.status || payload.action || "";

  if (action === "uninstalled") {
    // Mark store as uninstalled
    await db
      .update(slConnectorStores)
      .set({
        status: "uninstalled",
        uninstalledAt: new Date(),
      })
      .where(eq(slConnectorStores.id, slStoreId));

    // Cancel subscription
    await db
      .update(slConnectorSubscriptions)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
      })
      .where(eq(slConnectorSubscriptions.slStoreId, slStoreId));

    console.info(`[SHOPLINE Billing] App uninstalled: store=${slStoreId}`);
  } else {
    console.info(`[SHOPLINE Billing] Installation status changed: store=${slStoreId}, action=${action}`);
  }
}

// ─── Main Dispatcher ─────────────────────────────────────────────────────────

/**
 * Dispatches a billing/lifecycle webhook to the appropriate handler.
 * Called from the main webhook route when the topic matches a billing event.
 */
export async function processBillingWebhook(
  db: Db,
  organizationId: number,
  slStoreId: number,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (topic) {
    case "app_plan/activated":
      await handlePlanActivated(db, organizationId, slStoreId, payload as AppPlanActivatedPayload);
      break;
    case "app_plan/expired":
      await handlePlanExpired(db, organizationId, slStoreId, payload as AppPlanExpiredPayload);
      break;
    case "billing_attempts/succeed":
      await handleBillingSuccess(db, organizationId, slStoreId, payload as BillingAttemptPayload);
      break;
    case "billing_attempts/fail":
      await handleBillingFailure(db, organizationId, slStoreId, payload as BillingAttemptPayload);
      break;
    case "app/installation_status_changed":
      await handleInstallationStatusChanged(
        db,
        organizationId,
        slStoreId,
        payload as InstallationStatusPayload,
      );
      break;
    default:
      console.warn(`[SHOPLINE Billing] Unknown billing topic: ${topic}`);
  }
}

/**
 * Check if a store has an active (or trialing) subscription.
 */
export async function hasActiveSubscription(
  db: Db,
  slStoreId: number,
): Promise<boolean> {
  const [sub] = await db
    .select()
    .from(slConnectorSubscriptions)
    .where(eq(slConnectorSubscriptions.slStoreId, slStoreId))
    .limit(1);
  if (!sub) return false;
  return sub.status === "active" || sub.status === "trialing";
}

/**
 * Whether a store's subscription state should BLOCK data sync.
 *
 * Deliberately lenient + grace-aware:
 *  - No subscription row yet (freshly onboarded, before app_plan/activated) →
 *    allowed, so a webhook gap never strands a merchant.
 *  - trialing / active → allowed.
 *  - past_due or expired → allowed UNTIL graceEndsAt (the portal's 7-day
 *    buffer to resolve payment), then blocked. A missing graceEndsAt is
 *    treated as still-in-grace (fail-open) rather than an instant cut-off.
 *  - cancelled (explicit uninstall) → blocked immediately.
 */
export async function isSyncBlockedBySubscription(
  db: Db,
  slStoreId: number,
): Promise<{ blocked: boolean; status?: string; graceEndsAt?: Date | null; inGrace?: boolean }> {
  const [sub] = await db
    .select({ status: slConnectorSubscriptions.status, graceEndsAt: slConnectorSubscriptions.graceEndsAt })
    .from(slConnectorSubscriptions)
    .where(eq(slConnectorSubscriptions.slStoreId, slStoreId))
    .limit(1);
  if (!sub) return { blocked: false };

  if (sub.status === "cancelled") {
    return { blocked: true, status: sub.status };
  }
  if (sub.status === "past_due" || sub.status === "expired") {
    const grace = sub.graceEndsAt as Date | null;
    const inGrace = !grace || grace.getTime() > Date.now();
    return { blocked: !inGrace, status: sub.status, graceEndsAt: grace, inGrace };
  }
  // trialing / active
  return { blocked: false, status: sub.status };
}

/**
 * Get the current subscription for a store.
 */
export async function getStoreSubscription(
  db: Db,
  slStoreId: number,
) {
  const [sub] = await db
    .select()
    .from(slConnectorSubscriptions)
    .where(eq(slConnectorSubscriptions.slStoreId, slStoreId))
    .limit(1);
  return sub ?? null;
}
