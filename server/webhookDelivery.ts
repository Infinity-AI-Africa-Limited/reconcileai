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
 *   - HMAC-SHA256 signing (X-ReconcileAI-Signature over the raw body) and
 *     the on-premise egress guard, both preserved from the original.
 *
 * Events: exception.created, exception.resolved, exception.escalated,
 * exception.in_review, reconciliation.completed, upload.completed,
 * kpi.threshold.breached.
 */
import crypto from "crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { webhooks, webhookDeliveries } from "../drizzle/schema";
import { isEgressAllowed } from "./_core/egress";
import { createQueue, type JobQueue } from "./jobQueue";

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 30_000;

interface DeliveryJob {
  deliveryId: number;
  webhookId: number;
  url: string;
  secret: string;
  body: string; // pre-serialized so the signature is stable across retries
}

// ─── Delivery execution (queue handler) ──────────────────────────────────────

async function attemptDelivery(job: { data: DeliveryJob; attempt: number }): Promise<void> {
  const { deliveryId, webhookId, url, secret, body } = job.data;
  const db = await getDb();

  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  let responseStatus: number | null = null;
  let error: string | null = null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ReconcileAI-Signature": signature,
        "X-ReconcileAI-Delivery": String(deliveryId),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseStatus = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 500) : "network error";
  }

  const delivered = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
  const exhausted = !delivered && job.attempt >= MAX_ATTEMPTS;

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
          .where(eq(webhooks.id, webhookId));
      } else if (exhausted) {
        await db.update(webhooks)
          .set({ failureCount: sql`${webhooks.failureCount} + 1` })
          .where(eq(webhooks.id, webhookId));
      }
    } catch (dbErr) {
      console.error("[webhookDelivery] status update failed (non-fatal):", dbErr);
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
 * Fan an event out to every active webhook subscribed to it. Creates a
 * tracked delivery row per target and enqueues it. Never throws — webhook
 * delivery must not fail the operation that triggered the event.
 */
export async function dispatchWebhookEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;

    const targets = await db.select().from(webhooks).where(eq(webhooks.isActive, true));
    const subscribed = targets.filter((w) => {
      const events = Array.isArray(w.events) ? (w.events as string[]) : [];
      return events.includes(event) || events.includes("*");
    });
    if (subscribed.length === 0) return;

    const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
    // ids only — delivery rows must never hold transaction data.
    const payloadSummary = `${event} ${JSON.stringify(
      Object.fromEntries(Object.entries(payload).filter(([, v]) => typeof v === "number" || typeof v === "boolean")),
    )}`.slice(0, 500);

    const queue = await getQueue();
    for (const webhook of subscribed) {
      // Data residency: user-configured webhooks can carry reconciliation
      // payload references. In on-premise mode, only allowlisted hosts.
      if (!isEgressAllowed(webhook.url)) {
        console.warn(
          `[webhookDelivery] on-premise mode: blocked delivery to ${webhook.url} (event ${event}). ` +
            "Add the host to EGRESS_ALLOWLIST to permit it.",
        );
        continue;
      }

      const [row] = await db.insert(webhookDeliveries).values({
        webhookId: webhook.id,
        event,
        url: webhook.url,
        maxAttempts: MAX_ATTEMPTS,
        payloadSummary,
      }).$returningId();

      await queue.enqueue(event, {
        deliveryId: row.id,
        webhookId: webhook.id,
        url: webhook.url,
        secret: webhook.secret,
        body,
      });
    }
  } catch (err) {
    console.error("[webhookDelivery] dispatch error (non-fatal):", err);
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
