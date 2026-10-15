/**
 * Outbound webhook delivery (gap-closure plan WS-4).
 *
 * Replaces the fire-and-forget dispatch in routers.ts with tracked, retried
 * delivery:
 *   - one webhook_deliveries row per (webhook, event) dispatch — pending →
 *     delivered/failed, powering the admin dashboard and the ≥99.5%
 *     reliability KPI;
 *   - retries with exponential backoff through the queue abstraction
 *     (BullMQ when REDIS_URL is set, in-process otherwise);
 *   - HMAC-SHA256 signing (X-ReconcileAI-Signature over the raw body);
 *   - a destination guard (outboundDestination.ts): cloud mode sends only to
 *     public https hosts, checked at the socket so DNS cannot be swapped
 *     between check and connect, and never follows a redirect. On premise
 *     the egress allow-list decides.
 *
 * Events: exception.created, exception.resolved, exception.escalated,
 * exception.in_review, reconciliation.completed, reconciliation.failed,
 * upload.completed, kpi.threshold.breached.
 *
 * Every event belongs to one tenant and reaches only that tenant's webhooks
 * (see dispatchWebhookEvent). webhookDelivery.tenancy.test.ts holds the line.
 */
import crypto from "crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { webhooks, webhookDeliveries } from "../drizzle/schema";
import { DestinationRefusedError, bareHost, destinationPolicy, destinationProblem, postToDestination } from "./outboundDestination";
import { createQueue, QueueOperationTimeoutError, type JobQueue } from "./jobQueue";
import { loggableError } from "./dbErrors";
import { errorSummary } from "./errorText";
import { isTenantId } from "@shared/tenantId";
import { ALL_WEBHOOK_EVENTS, type WebhookEvent } from "@shared/webhookEvents";

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 30_000;

/**
 * What a queued delivery carries: ids and the signed body, nothing else.
 *
 * The URL and signing secret are read from the webhook at each attempt. The
 * secret then never sits in Redis, and a webhook deleted after dispatch stops
 * receiving the retries already queued for it. `organizationId` scopes that
 * read, so a job can only ever load its own tenant's webhook.
 */
interface DeliveryJob {
  deliveryId: number;
  webhookId: number;
  organizationId: number;
  event: WebhookEvent;
  body: string; // pre-serialized so the signature is stable across retries
}

// ─── Delivery execution (queue handler) ──────────────────────────────────────

/**
 * The webhook a delivery is for, read within the tenant it was dispatched for.
 * Null means it is gone. A database that cannot answer THROWS rather than
 * reading as "gone": that is a reason to retry, not to give up.
 */
async function deliveryTarget(
  webhookId: number,
  organizationId: number,
): Promise<{ url: string; secret: string; isActive: boolean } | null> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [target] = await db
    .select({ url: webhooks.url, secret: webhooks.secret, isActive: webhooks.isActive })
    .from(webhooks)
    .where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.id, webhookId)))
    .limit(1);
  return target ?? null;
}

async function attemptDelivery(job: { data: DeliveryJob; attempt: number }): Promise<void> {
  const { deliveryId, webhookId, organizationId, event, body } = job.data;
  const db = await getDb();

  let responseStatus: number | null = null;
  let error: string | null = null;
  // A failure no retry can change: the destination is refused, or the webhook
  // is gone. Settled now rather than retried six times.
  let final = false;

  // Read through the same failure path as the send: a read that fails is an
  // attempt like any other, retried, and on the last attempt settled as
  // failed. Thrown out of here, it skipped the status update, and the row sat
  // `pending` for ever once the queue stopped retrying (Greptile, #196).
  let target: Awaited<ReturnType<typeof deliveryTarget>> = null;
  let readFailed = false;
  try {
    target = isTenantId(organizationId) ? await deliveryTarget(webhookId, organizationId) : null;
  } catch (err) {
    readFailed = true;
    error = `Could not read the webhook: ${errorSummary(err)}`;
  }

  // A failed read leaves `error` set: retried below, or failed once exhausted.
  if (!readFailed && !target?.isActive) {
    error = "Not sent: the webhook was deleted";
    final = true;
  } else if (target?.isActive) {
    const signature = crypto.createHmac("sha256", target.secret).update(body).digest("hex");
    try {
      const res = await postToDestination(
        target.url,
        {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "ReconcileAI-Webhooks/1.0",
            // Hex HMAC-SHA256 of the raw body under the webhook's secret. The
            // body carries a signed `timestamp`, for a receiver's freshness check.
            "X-ReconcileAI-Signature": signature,
            "X-ReconcileAI-Event": event,
            // Stable across retries: a receiver de-duplicates on it.
            "X-ReconcileAI-Delivery": String(deliveryId),
          },
          body,
          timeoutMs: DELIVERY_TIMEOUT_MS,
        },
        destinationPolicy(),
      );
      responseStatus = res.status;
      if (res.status >= 300 && res.status < 400) error = `HTTP ${res.status}: redirects are not followed`;
      else if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof DestinationRefusedError) {
        error = errorSummary(err);
        final = true;
      } else {
        error = err instanceof Error ? errorSummary(err) : "network error";
      }
    }
  }

  const delivered = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
  const exhausted = !delivered && (final || job.attempt >= MAX_ATTEMPTS);

  if (db) {
    try {
      await db.update(webhookDeliveries)
        .set({
          attempts: job.attempt,
          lastAttemptAt: new Date(),
          responseStatus,
          lastError: error,
          status: delivered ? "delivered" : exhausted ? "failed" : "pending",
          ...(delivered ? { deliveredAt: new Date() } : {}),
        })
        .where(eq(webhookDeliveries.id, deliveryId));

      if (delivered) {
        await db.update(webhooks)
          .set({ lastTriggeredAt: new Date() })
          .where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.id, webhookId)));
      } else if (exhausted) {
        await db.update(webhooks)
          .set({ failureCount: sql`${webhooks.failureCount} + 1` })
          .where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.id, webhookId)));
      }
    } catch (dbErr) {
      console.error("[webhookDelivery] status update failed (non-fatal):", loggableError(dbErr));
    }
  }

  // Throwing signals the queue to retry (until the queue's attempt limit,
  // which matches MAX_ATTEMPTS).
  if (!delivered && !exhausted) {
    throw new Error(error ?? `HTTP ${responseStatus}`);
  }
}

// Lazy singleton so the queue backend (BullMQ vs in-process) is decided once.
let queuePromise: Promise<JobQueue<DeliveryJob>> | null = null;
function getQueue(): Promise<JobQueue<DeliveryJob>> {
  if (!queuePromise) {
    queuePromise = createQueue<DeliveryJob>("webhook-delivery", attemptDelivery, {
      attempts: MAX_ATTEMPTS,
      backoffMs: BACKOFF_BASE_MS,
    });
  }
  return queuePromise;
}

// ─── Dispatch (called from routers/gateway) ──────────────────────────────────

/**
 * The active webhooks ONE tenant owns. The only way dispatch finds targets.
 *
 * Until 2026-10-14 dispatch selected on `isActive` alone, so every tenant's
 * events went to every tenant's webhooks: a user at bank B could subscribe to
 * "*" and receive bank A's run results and exception activity. A webhook with
 * no organisation matches nothing here, so an unattributable row receives no
 * events at all.
 */
export async function activeWebhooksOfTenant(organizationId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.isActive, true)));
}

/**
 * Fan an event out to the active webhooks of the tenant the event belongs to,
 * and to no one else. Creates a tracked delivery row per target and enqueues
 * it. Never throws — webhook delivery must not fail the operation that
 * triggered the event.
 *
 * `organizationId` is the tenant that owns the thing the event is about: the
 * job's, the exception's, the upload's. Not the caller's by default — staff in
 * a portal act for a tenant that is not their own (CLAUDE.md §6). It must be a
 * real tenant (`isTenantId`); anything else is refused and nothing is sent.
 */
export async function dispatchWebhookEvent(
  organizationId: number,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    // The type says `number`; this refuses the numbers that are not tenants
    // (0, negatives, NaN) and anything an `as` smuggled past the compiler.
    if (!isTenantId(organizationId)) {
      console.error(
        `[webhookDelivery] refused ${event}: no owning tenant (got ${String(organizationId)}); nothing was sent`,
      );
      return;
    }

    const targets = await activeWebhooksOfTenant(organizationId);
    const subscribed = targets.filter((w) => {
      // Second, independent barrier. The query above is the control; this is
      // here so a future edit to it fails safe rather than open.
      if (w.organizationId !== organizationId) {
        console.error(
          `[webhookDelivery] webhook ${w.id} is not tenant ${organizationId}'s; withheld ${event}. ` +
            "activeWebhooksOfTenant returned another tenant's row.",
        );
        return false;
      }
      const events = Array.isArray(w.events) ? (w.events as string[]) : [];
      return events.includes(event) || events.includes(ALL_WEBHOOK_EVENTS);
    });
    if (subscribed.length === 0) return;

    const db = await getDb();
    if (!db) return;

    const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
    // ids only — delivery rows must never hold transaction data.
    const payloadSummary = `${event} ${JSON.stringify(
      Object.fromEntries(Object.entries(payload).filter(([, v]) => typeof v === "number" || typeof v === "boolean")),
    )}`.slice(0, 500);

    const queue = await getQueue();
    const policy = destinationPolicy();
    // Set once an enqueue times out: every later one in this fan-out would wait
    // out the same deadline, so the rest are recorded as not queued at once.
    let unreachable: QueueOperationTimeoutError | null = null;
    for (const webhook of subscribed) {
      // A destination this deployment refuses (an internal address, a host off
      // the on-premise allow-list) is recorded as a failed delivery with its
      // reason, so the admin sees why, and is never queued. Delivery checks
      // again at the socket: DNS can change after this.
      const refused = destinationProblem(webhook.url, policy);
      if (refused) {
        console.warn(
          `[webhookDelivery] refused ${event} to webhook ${webhook.id} (${hostOf(webhook.url)}): ${refused}`,
        );
        await db.insert(webhookDeliveries).values({
          webhookId: webhook.id,
          event,
          url: webhook.url,
          status: "failed",
          maxAttempts: MAX_ATTEMPTS,
          // The reason names a host or an address, never the URL.
          lastError: `Destination refused: ${refused}`.slice(0, 500),
          payloadSummary,
        });
        continue;
      }

      const [row] = await db.insert(webhookDeliveries).values({
        webhookId: webhook.id,
        event,
        url: webhook.url,
        maxAttempts: MAX_ATTEMPTS,
        payloadSummary,
      }).$returningId();

      try {
        if (unreachable) throw unreachable;
        await queue.enqueue(event, {
          deliveryId: row.id,
          webhookId: webhook.id,
          organizationId,
          event,
          body,
        });
      } catch (err) {
        // Per subscriber: one failed enqueue must not abandon the others.
        if (err instanceof QueueOperationTimeoutError) unreachable = err;
        await markNotQueued(row.id, err);
      }
    }
  } catch (err) {
    console.error("[webhookDelivery] dispatch error (non-fatal):", loggableError(err));
  }
}

/** A webhook URL's host, for logs: its path or query can carry a token. */
function hostOf(raw: string): string {
  try {
    return bareHost(new URL(raw).hostname);
  } catch {
    return "invalid URL";
  }
}

/**
 * Settle a delivery row whose enqueue failed, so it reads `failed` with a
 * reason rather than sitting `pending` for ever with nothing to send it.
 *
 * Only while still `pending` with no attempt made: an enqueue that timed out
 * may still land once Redis answers, and a delivery that then runs records its
 * own outcome, which must stand.
 */
async function markNotQueued(deliveryId: number, err: unknown): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db
      .update(webhookDeliveries)
      // errorSummary caps a message at 200 characters, so this fits lastError (500).
      .set({ status: "failed", lastError: `Not queued: ${errorSummary(err)}` })
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.status, "pending"),
          eq(webhookDeliveries.attempts, 0),
        ),
      );
  } catch (dbErr) {
    console.error("[webhookDelivery] could not record an unqueued delivery (non-fatal):", loggableError(dbErr));
  }
}

// ─── Admin dashboard queries ─────────────────────────────────────────────────

/** Recent deliveries for an organization's webhooks (newest first). */
export async function listDeliveries(organizationId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: webhookDeliveries.id,
      webhookId: webhookDeliveries.webhookId,
      webhookName: webhooks.name,
      event: webhookDeliveries.event,
      url: webhookDeliveries.url,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      responseStatus: webhookDeliveries.responseStatus,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      deliveredAt: webhookDeliveries.deliveredAt,
    })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(eq(webhooks.organizationId, organizationId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}

/** Delivery reliability over a window — the ≥99.5% WS-4 success criterion. */
export async function deliveryStats(organizationId: number, sinceDays = 30) {
  const db = await getDb();
  if (!db) return { total: 0, delivered: 0, failed: 0, pending: 0, reliability: null as number | null };
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      delivered: sql<number>`coalesce(sum(case when ${webhookDeliveries.status} = 'delivered' then 1 else 0 end), 0)`,
      failed: sql<number>`coalesce(sum(case when ${webhookDeliveries.status} = 'failed' then 1 else 0 end), 0)`,
      pending: sql<number>`coalesce(sum(case when ${webhookDeliveries.status} = 'pending' then 1 else 0 end), 0)`,
    })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(and(eq(webhooks.organizationId, organizationId), gte(webhookDeliveries.createdAt, since)));

  const total = Number(row?.total || 0);
  const delivered = Number(row?.delivered || 0);
  const settled = delivered + Number(row?.failed || 0);
  return {
    total,
    delivered,
    failed: Number(row?.failed || 0),
    pending: Number(row?.pending || 0),
    // measured over settled deliveries; null until there is data
    reliability: settled > 0 ? Math.round((delivered / settled) * 10000) / 100 : null,
  };
}
