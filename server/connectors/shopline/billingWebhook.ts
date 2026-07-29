/**
 * SHOPLINE App-Subscription (Billing) Webhook Handler
 *
 * SHOPLINE has a NATIVE App Store billing system (like Shopify's): we define
 * the plans in the Partner Portal, SHOPLINE collects payment from the merchant
 * and pays us via PayPal minus the rev share, and notifies us by webhook. We
 * never charge a card. The three real topics:
 *
 * - appsubscription/create     → merchant subscribes OR renews (carries subPackage)
 * - appsubscription/paid       → payment finalised (status 200 ok / 300 cancelled / 400 failed)
 * - appsubscription/expiration → plan expired (expireType 0..4)
 *
 * These are registered in the Partner Portal (not via API). The APP Secret is
 * the HMAC signing key.
 *
 * The store is identified by the payload's `handle` (store subdomain) — billing
 * webhooks are app-scoped, so they may not carry the shop-domain header the
 * store webhooks use.
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
  SHOPLINE_BILLING_PAID_STATUS,
  SHOPLINE_BILLING_EXPIRE_TYPE,
  type SubscriptionBandId,
} from "../../../shared/shoplineConstants";

const DAY_MS = 24 * 60 * 60 * 1000;
/** now + TIER_1_GRACE_PERIOD_DAYS — the buffer end after a failed renewal/expiry. */
function graceDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + TIER_1_GRACE_PERIOD_DAYS * DAY_MS);
}

/**
 * Grace deadline honouring the value SHOPLINE sends on the subscription
 * (`gracePeriod` + `gracePeriodUnit`), falling back to our portal-configured
 * 7 days when absent. The platform is the source of truth for its own buffer.
 */
function graceDeadlineFrom(
  pkg: SubPackage | undefined,
  from: Date = new Date(),
): Date {
  const qty = typeof pkg?.gracePeriod === "number" ? pkg.gracePeriod : null;
  if (qty === null || qty <= 0) return graceDeadline(from);
  const unit = (pkg?.gracePeriodUnit ?? "DAY").toUpperCase();
  const ms = unit === "SECOND" ? qty * 1000 : qty * DAY_MS;
  return new Date(from.getTime() + ms);
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ─── Webhook Payload Interfaces (verified shapes) ────────────────────────────

/** `subPackage` block on appsubscription/create. */
export interface SubPackage {
  /** Plan identifier we defined in the Partner Portal (our band spuKey). */
  spuKey?: string;
  trial?: boolean;
  autoRenewStatus?: boolean;
  /** Epoch ms. */
  startAt?: number;
  endAt?: number;
  period?: number;
  /** DAY | MONTH | YEAR */
  periodType?: string;
  /** Platform-provided grace buffer. */
  gracePeriod?: number;
  /** SECOND | DAY */
  gracePeriodUnit?: string;
  featureKeyList?: string[];
  serviceKeyList?: Array<{
    serviceKey?: string;
    totalQty?: number;
    availableQty?: number;
    indefinite?: boolean;
  }>;
}

export interface AppSubscriptionCreatePayload {
  appkey?: string;
  /** Store handle (subdomain) — the store identifier on billing webhooks. */
  handle?: string;
  subId?: string;
  subPackage?: SubPackage;
}

export interface AppSubscriptionPaidPayload {
  appkey?: string;
  /** Our internal order number from SHOPLINE. */
  bizOrderNo?: string;
  handle?: string;
  /** 200 = success, 300 = cancelled, 400 = failed. */
  status?: number;
  subId?: string;
  /** Epoch ms. */
  subTime?: number;
}

export interface AppSubscriptionExpirationPayload {
  appkey?: string;
  handle?: string;
  subId?: string;
  /** 0 terminated | 1 upgrade | 2 manual cancel | 3 grace period | 4 next cycle activated */
  expireType?: number;
  type?: number;
  subPackage?: SubPackage;
}

/**
 * Resolve the SHOPLINE store row from a billing payload's `handle`.
 * Billing webhooks are app-scoped, so the store-domain header used by store
 * webhooks may be absent — this is the reliable identifier.
 */
export async function resolveStoreByHandle(
  db: Db,
  handle: string | undefined,
): Promise<{ id: number; organizationId: number } | null> {
  if (!handle) return null;
  const clean = handle.replace(/\.myshopline\.com$/i, "");
  const [store] = await db
    .select({ id: slConnectorStores.id, organizationId: slConnectorStores.organizationId })
    .from(slConnectorStores)
    .where(eq(slConnectorStores.storeHandle, clean))
    .limit(1);
  return store ?? null;
}

// ─── Handler Functions ───────────────────────────────────────────────────────

/**
 * appsubscription/create — merchant subscribed OR renewed.
 * Creates or updates the subscription record for the store.
 */
export async function handleSubscriptionCreate(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: AppSubscriptionCreatePayload,
): Promise<void> {
  const pkg = payload.subPackage;
  const subscriptionId = payload.subId ?? null;
  const planKey = (pkg?.spuKey || "starter") as SubscriptionBandId;
  const isTrial = pkg?.trial ?? false;

  // Validate planKey exists in our bands (unknown → keep it, plan limits fail open)
  const band = TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === planKey);
  if (!band) {
    console.warn(`[SHOPLINE Billing] Unknown plan key from portal: ${planKey}`);
  }

  const now = new Date();
  // Prefer SHOPLINE's own period bounds; fall back to our trial constant.
  const periodStart = pkg?.startAt ? new Date(pkg.startAt) : now;
  const periodEnd = pkg?.endAt ? new Date(pkg.endAt) : null;
  const trialEnd = isTrial
    ? (periodEnd ?? new Date(now.getTime() + TIER_1_FREE_TRIAL_DAYS * DAY_MS))
    : null;

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
        trialStartedAt: isTrial ? (existing.trialStartedAt ?? now) : existing.trialStartedAt,
        trialEndsAt: isTrial ? trialEnd : existing.trialEndsAt,
        activatedAt: isTrial ? existing.activatedAt : now,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelledAt: null,
        graceEndsAt: null, // subscribing/renewing clears any grace buffer
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
      trialEndsAt: trialEnd,
      activatedAt: isTrial ? null : now,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      failedBillingAttempts: 0,
    });
  }

  console.info(
    `[SHOPLINE Billing] Subscription created/renewed: store=${slStoreId}, plan=${planKey}, trial=${isTrial}, period=${pkg?.period ?? "?"}${pkg?.periodType ?? ""}`,
  );
}

/**
 * appsubscription/expiration — the plan ended.
 *
 * `expireType` matters: an UPGRADE or NEXT_CYCLE_ACTIVATED is a *continuation*
 * (SHOPLINE follows it with a create for the new package), so it must NOT end
 * the merchant's access. Only a termination / manual cancel / grace-period
 * expiry moves the subscription to `expired` and starts the buffer.
 */
export async function handleSubscriptionExpiration(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: AppSubscriptionExpirationPayload,
): Promise<void> {
  const now = new Date();
  const expireType = payload.expireType ?? payload.type;

  const isContinuation =
    expireType === SHOPLINE_BILLING_EXPIRE_TYPE.UPGRADE ||
    expireType === SHOPLINE_BILLING_EXPIRE_TYPE.NEXT_CYCLE_ACTIVATED;

  if (isContinuation) {
    console.info(
      `[SHOPLINE Billing] Subscription superseded (expireType=${expireType}) — access retained: store=${slStoreId}`,
    );
    return;
  }

  // Preserve an already-running grace deadline so a repeat event can't extend it.
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

  // A grace-period expiry means the buffer itself has run out → block now.
  const graceExhausted = expireType === SHOPLINE_BILLING_EXPIRE_TYPE.GRACE_PERIOD;
  const graceEndsAt = graceExhausted
    ? now
    : (existing?.graceEndsAt ?? graceDeadlineFrom(payload.subPackage, now));

  await db
    .update(slConnectorSubscriptions)
    .set({
      status: "expired",
      cancelledAt: now,
      graceEndsAt,
    })
    .where(
      and(
        eq(slConnectorSubscriptions.slStoreId, slStoreId),
        eq(slConnectorSubscriptions.organizationId, organizationId),
      ),
    );

  console.info(
    `[SHOPLINE Billing] Subscription expired: store=${slStoreId}, expireType=${expireType}, grace ends ${graceEndsAt.toISOString()}`,
  );
}

/**
 * appsubscription/paid — a payment was finalised.
 *
 * `status` drives the outcome: 200 confirms the subscription (clears grace and
 * failure counters); 400 is a failed charge (counts toward past_due and starts
 * the grace buffer); 300 is a cancellation.
 */
export async function handleSubscriptionPaid(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: AppSubscriptionPaidPayload,
): Promise<void> {
  const status = payload.status;
  const paidAt = payload.subTime ? new Date(payload.subTime) : new Date();

  const where = and(
    eq(slConnectorSubscriptions.slStoreId, slStoreId),
    eq(slConnectorSubscriptions.organizationId, organizationId),
  );

  // ── Success ───────────────────────────────────────────────────────────────
  if (status === SHOPLINE_BILLING_PAID_STATUS.SUCCESS) {
    await db
      .update(slConnectorSubscriptions)
      .set({
        status: "active",
        activatedAt: paidAt,
        currentPeriodStart: paidAt,
        graceEndsAt: null, // successful charge clears any grace buffer
        failedBillingAttempts: 0,
        lastFailureReason: null,
      })
      .where(where);
    console.info(`[SHOPLINE Billing] Payment succeeded: store=${slStoreId}, order=${payload.bizOrderNo ?? "?"}`);
    return;
  }

  // ── Cancelled ─────────────────────────────────────────────────────────────
  if (status === SHOPLINE_BILLING_PAID_STATUS.CANCELLED) {
    await db
      .update(slConnectorSubscriptions)
      .set({ status: "cancelled", cancelledAt: paidAt })
      .where(where);
    console.info(`[SHOPLINE Billing] Payment cancelled: store=${slStoreId}, order=${payload.bizOrderNo ?? "?"}`);
    return;
  }

  // ── Failed ────────────────────────────────────────────────────────────────
  const [existing] = await db
    .select()
    .from(slConnectorSubscriptions)
    .where(where)
    .limit(1);

  const attempts = (existing?.failedBillingAttempts ?? 0) + 1;
  // After 3 failed charges, mark past_due (SHOPLINE applies its own threshold
  // too); before that, preserve the existing status.
  const goesPastDue = attempts >= 3;
  const newStatus = goesPastDue ? "past_due" : (existing?.status ?? "active");
  // Entering past_due starts the grace buffer once — repeated failures must not
  // extend it.
  const graceEndsAt = goesPastDue
    ? ((existing?.graceEndsAt as Date | null | undefined) ?? graceDeadline(paidAt))
    : ((existing?.graceEndsAt as Date | null | undefined) ?? null);

  await db
    .update(slConnectorSubscriptions)
    .set({
      status: newStatus,
      graceEndsAt,
      failedBillingAttempts: attempts,
      lastFailureReason: `Payment failed (status ${status ?? "unknown"}, order ${payload.bizOrderNo ?? "?"})`,
    })
    .where(where);

  console.warn(
    `[SHOPLINE Billing] Payment failed: store=${slStoreId}, attempts=${attempts}, status=${status}`,
  );
}

/**
 * Cancel a store's subscription — called from the uninstall path
 * (`shop/redact`, which SHOPLINE fires 48h after an uninstall). There is no
 * `app/installation_status_changed` topic; uninstall reaches us via GDPR.
 */
export async function cancelSubscriptionForStore(
  db: Db,
  slStoreId: number,
): Promise<void> {
  await db
    .update(slConnectorSubscriptions)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(eq(slConnectorSubscriptions.slStoreId, slStoreId));
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
    case "appsubscription/create":
      await handleSubscriptionCreate(db, organizationId, slStoreId, payload as AppSubscriptionCreatePayload);
      break;
    case "appsubscription/paid":
      await handleSubscriptionPaid(db, organizationId, slStoreId, payload as AppSubscriptionPaidPayload);
      break;
    case "appsubscription/expiration":
      await handleSubscriptionExpiration(
        db,
        organizationId,
        slStoreId,
        payload as AppSubscriptionExpirationPayload,
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
