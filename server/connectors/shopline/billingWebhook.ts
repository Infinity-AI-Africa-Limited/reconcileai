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
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  slConnectorBillingCharges,
  slConnectorSubscriptions,
  slConnectorStores,
  type SlConnectorBillingCharge,
  type SlConnectorSubscription,
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

/** Longest `bizOrderNo` the charge ledger can store (`sl_connector_billing_charges.bizOrderNo`). */
const BIZ_ORDER_NO_MAX_LENGTH = 128;

/**
 * The charge a paid delivery reports, as the ledger keys it, or null when the
 * payload names none we can key on. SHOPLINE documents `bizOrderNo` as a
 * string; a safe integer is taken as its digits. An over-long value is refused
 * rather than truncated, because two charges sharing a prefix would become one.
 */
export function billingChargeRef(bizOrderNo: unknown): string | null {
  const raw = Number.isSafeInteger(bizOrderNo) ? String(bizOrderNo) : bizOrderNo;
  if (typeof raw !== "string") return null;
  const ref = raw.trim();
  return ref.length > 0 && ref.length <= BIZ_ORDER_NO_MAX_LENGTH ? ref : null;
}

/**
 * What one `appsubscription/paid` delivery did.
 *
 * - `succeeded`, `cancelled`, `failure_counted`: this outcome of this charge
 *   took effect, for the first time.
 * - `duplicate`: an earlier delivery already applied this outcome of this
 *   charge. SHOPLINE retries deliveries, and two subscriptions to one topic
 *   deliver each event twice under two webhook ids.
 * - `stale_failure`: a failure reported for a charge that has already
 *   succeeded or been cancelled. It is not news, so it never re-opens failures.
 * - `failure_unidentified`: a failure with no charge reference. Nothing tells
 *   it apart from a re-delivery, so it is recorded and never counted.
 * - `no_subscription`: the store has no subscription row to apply it to.
 */
export type PaidDeliveryOutcome =
  | "succeeded"
  | "cancelled"
  | "failure_counted"
  | "duplicate"
  | "stale_failure"
  | "failure_unidentified"
  | "no_subscription";

/** One charge's ledger row, confined to its store and the store's tenant. */
function chargeOf(organizationId: number, slStoreId: number, bizOrderNo: string) {
  return and(
    eq(slConnectorBillingCharges.slStoreId, slStoreId),
    eq(slConnectorBillingCharges.organizationId, organizationId),
    eq(slConnectorBillingCharges.bizOrderNo, bizOrderNo),
  );
}

/** The changes one delivery makes. Decided under the locks, from the locked rows. */
interface PaidDeliveryDecision {
  outcome: Exclude<PaidDeliveryOutcome, "no_subscription">;
  subscription?: Partial<SlConnectorSubscription>;
  charge?: Partial<SlConnectorBillingCharge>;
}

/**
 * Apply each outcome of a charge once.
 *
 * A failure counts toward past_due only the first time its charge reports one,
 * and never once the charge has succeeded or been cancelled: a failure
 * re-delivered after the store paid must not re-open the count. A success or
 * cancellation re-delivered later must not undo what happened since, such as a
 * newer failed charge or a re-subscription. Without a charge reference only
 * success and cancellation still apply, as before; they set state rather than
 * count, so a repeat back to back changes nothing.
 */
function decidePaidDelivery(input: {
  status: number | undefined;
  chargeRef: string | null;
  charge: SlConnectorBillingCharge | null;
  sub: SlConnectorSubscription;
  paidAt: Date;
  now: Date;
}): PaidDeliveryDecision {
  const { status, chargeRef, charge, sub, paidAt, now } = input;
  const delivered = charge ? { deliveries: charge.deliveries + 1 } : undefined;

  // ── Success ───────────────────────────────────────────────────────────────
  if (status === SHOPLINE_BILLING_PAID_STATUS.SUCCESS) {
    if (charge?.succeededAt) return { outcome: "duplicate", charge: delivered };
    return {
      outcome: "succeeded",
      subscription: {
        status: "active",
        activatedAt: paidAt,
        currentPeriodStart: paidAt,
        graceEndsAt: null, // successful charge clears any grace buffer
        failedBillingAttempts: 0,
        lastFailureReason: null,
      },
      charge: charge ? { ...delivered, succeededAt: now } : undefined,
    };
  }

  // ── Cancelled ─────────────────────────────────────────────────────────────
  if (status === SHOPLINE_BILLING_PAID_STATUS.CANCELLED) {
    if (charge?.cancelledAt) return { outcome: "duplicate", charge: delivered };
    return {
      outcome: "cancelled",
      subscription: { status: "cancelled", cancelledAt: paidAt },
      charge: charge ? { ...delivered, cancelledAt: now } : undefined,
    };
  }

  // ── Failed ────────────────────────────────────────────────────────────────
  if (chargeRef === null || charge === null) {
    return {
      outcome: "failure_unidentified",
      subscription: {
        lastFailureReason: `Payment failed (status ${status ?? "unknown"}) with no charge reference (bizOrderNo), so it was not counted toward past_due`,
      },
    };
  }
  if (charge.failureCountedAt) return { outcome: "duplicate", charge: delivered };
  if (charge.succeededAt || charge.cancelledAt) return { outcome: "stale_failure", charge: delivered };

  const attempts = sub.failedBillingAttempts + 1;
  // After 3 failed charges, mark past_due (SHOPLINE applies its own threshold
  // too); before that, preserve the existing status.
  const goesPastDue = attempts >= 3;
  return {
    outcome: "failure_counted",
    subscription: {
      status: goesPastDue ? "past_due" : sub.status,
      // Entering past_due starts the grace buffer once — repeated failures must
      // not extend it.
      graceEndsAt: goesPastDue ? (sub.graceEndsAt ?? graceDeadline(paidAt)) : sub.graceEndsAt,
      failedBillingAttempts: attempts,
      lastFailureReason: `Payment failed (status ${status ?? "unknown"}, order ${chargeRef})`,
    },
    charge: { ...delivered, failureCountedAt: now },
  };
}

/**
 * appsubscription/paid — a payment was finalised.
 *
 * `status` drives the outcome: 200 confirms the subscription (clears grace and
 * failure counters); 400 is a failed charge (counts toward past_due and starts
 * the grace buffer); 300 is a cancellation.
 *
 * Idempotent per CHARGE (`bizOrderNo`), not per delivery. Webhook dedupe keys
 * on `X-Shopline-Webhook-Id`, and one charge can arrive under several: two
 * subscriptions to this topic (a legacy Partner Portal configuration beside
 * the one the connector registers) each deliver it with their own id. Counting
 * per delivery would count one failed charge twice and cut the merchant's
 * grace short. The charge ledger (`sl_connector_billing_charges`) records which
 * outcomes of each charge have taken effect.
 *
 * This assumes `bizOrderNo` names one charge attempt. If SHOPLINE reuses it
 * across retries of one renewal, those retries count once. That under-counts,
 * which is the safe direction: SHOPLINE's own expiration (expireType 3) still
 * ends access when its grace runs out.
 */
export async function handleSubscriptionPaid(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: AppSubscriptionPaidPayload,
): Promise<PaidDeliveryOutcome> {
  const status = payload.status;
  const chargeRef = billingChargeRef(payload.bizOrderNo);

  const applied = await db.transaction(async (tx) => {
    // Every delivery for this store is applied under the subscription row's
    // lock, one at a time, so two deliveries of one charge cannot both count
    // it and two different charges cannot overwrite each other's count. It is
    // the first statement, so there is one lock order.
    const [sub] = await tx
      .select()
      .from(slConnectorSubscriptions)
      .where(
        and(
          eq(slConnectorSubscriptions.slStoreId, slStoreId),
          eq(slConnectorSubscriptions.organizationId, organizationId),
        ),
      )
      .limit(1)
      .for("update");
    if (!sub) return { outcome: "no_subscription" as const };

    // Read after the lock: a delivery that queued behind another must not act
    // on a clock from before the wait.
    const now = new Date();
    const paidAt = payload.subTime ? new Date(payload.subTime) : now;

    let charge: SlConnectorBillingCharge | null = null;
    if (chargeRef !== null) {
      await tx
        .insert(slConnectorBillingCharges)
        .values({ organizationId, slStoreId, bizOrderNo: chargeRef, deliveries: 0 })
        .onDuplicateKeyUpdate({ set: { bizOrderNo: sql`${slConnectorBillingCharges.bizOrderNo}` } });
      // A locking read: TiDB answers a plain read from the snapshot this
      // transaction began with, which can predate the delivery that held the
      // lock before it and has since committed.
      const [row] = await tx
        .select()
        .from(slConnectorBillingCharges)
        .where(chargeOf(organizationId, slStoreId, chargeRef))
        .limit(1)
        .for("update");
      if (!row) throw new Error("SHOPLINE billing charge row missing after insert");
      charge = row;
    }

    const decision = decidePaidDelivery({ status, chargeRef, charge, sub, paidAt, now });
    if (decision.charge && chargeRef !== null) {
      await tx
        .update(slConnectorBillingCharges)
        .set(decision.charge)
        .where(chargeOf(organizationId, slStoreId, chargeRef));
    }
    if (decision.subscription) {
      await tx
        .update(slConnectorSubscriptions)
        .set(decision.subscription)
        .where(
          and(
            eq(slConnectorSubscriptions.slStoreId, slStoreId),
            eq(slConnectorSubscriptions.organizationId, organizationId),
          ),
        );
    }
    return {
      outcome: decision.outcome,
      failedBillingAttempts: decision.subscription?.failedBillingAttempts ?? sub.failedBillingAttempts,
      deliveries: decision.charge?.deliveries ?? charge?.deliveries,
    };
  });

  // Logged after the commit, so a line never reports a change that rolled back.
  const order = chargeRef ?? "?";
  switch (applied.outcome) {
    case "succeeded":
      console.info(`[SHOPLINE Billing] Payment succeeded: store=${slStoreId}, order=${order}`);
      break;
    case "cancelled":
      console.info(`[SHOPLINE Billing] Payment cancelled: store=${slStoreId}, order=${order}`);
      break;
    case "failure_counted":
      console.warn(
        `[SHOPLINE Billing] Payment failed: store=${slStoreId}, order=${order}, attempts=${applied.failedBillingAttempts}, status=${status}`,
      );
      break;
    case "duplicate":
      console.info(
        `[SHOPLINE Billing] Charge outcome already applied, delivery ignored: store=${slStoreId}, order=${order}, status=${status}, deliveries=${applied.deliveries}`,
      );
      break;
    case "stale_failure":
      console.warn(
        `[SHOPLINE Billing] Failure for a charge that already succeeded or was cancelled, not counted: store=${slStoreId}, order=${order}, deliveries=${applied.deliveries}`,
      );
      break;
    case "failure_unidentified":
      console.warn(
        `[SHOPLINE Billing] Payment failed with no charge reference (bizOrderNo), not counted: store=${slStoreId}, status=${status}`,
      );
      break;
    case "no_subscription":
      console.warn(
        `[SHOPLINE Billing] No subscription for store=${slStoreId}; paid delivery not applied (status=${status}, order=${order})`,
      );
      break;
  }
  return applied.outcome;
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
