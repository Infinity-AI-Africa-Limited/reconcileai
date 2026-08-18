/**
 * SHOPLINE Webhook Ingestion Handler
 *
 * Handles inbound webhook deliveries from SHOPLINE. All topics relevant to
 * payment reconciliation are processed here.
 *
 * Verified webhook topics (spec §A7):
 *   orders/create       — new order placed
 *   orders/updated      — order status change (financial_status, fulfillment)
 *   orders/edited       — order line items edited post-creation
 *   orders/paid         — order payment confirmed (triggers reconciliation candidate)
 *   orders/cancelled    — order cancelled (may need reversal)
 *   orders/delete       — order deleted (rare, cleanup)
 *   refunds/create      — refund issued (exception candidate: REFUND_NOT_CREDITED)
 *   refunds/update      — refund status change
 *   order_transactions/create — new payment transaction on an order
 *
 * GDPR mandatory topics (configured in Developer Center, not via API):
 *   customers/redact    — customer data deletion request
 *   merchants/redact    — merchant data deletion (app uninstall + data purge)
 *
 * Idempotency: each webhook has a unique `X-Shopline-Webhook-Id` header.
 * Duplicate deliveries are detected via the `sl_connector_webhook_events` table.
 *
 * Delivery contract: SHOPLINE retries up to 19 times over ~48h on non-2xx.
 * We MUST respond 200 within 5 seconds (queue-first design).
 *
 * DLQ: events that fail processing after 3 attempts are marked `dlq`.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "../../db";
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
import { slConnectorWebhookEvents, slConnectorStores } from "../../../drizzle/connector_schema";
import { verifyWebhookHmac } from "./signature";
import { ENV } from "../../_core/env";
import { deleteToken } from "./tokenStore";
import { processBillingWebhook } from "./billingWebhook";
import { scheduleReconciliation } from "./realtimeSync";
import { SHOPLINE_BILLING_WEBHOOK_TOPICS } from "../../../shared/shoplineConstants";

export interface InboundWebhook {
  /** Value of X-Shopline-Webhook-Id header */
  webhookId: string;
  /** Value of X-Shopline-Topic header (e.g. "orders/paid") */
  topic: string;
  /** Value of X-Shopline-Hmac-Sha256 header */
  hmacSignature: string;
  /** Value of X-Shopline-Shop-Domain header (e.g. "mystore.myshopline.com") */
  shopDomain: string;
  /** Raw request body as Buffer (needed for HMAC verification) */
  rawBody: Buffer;
}

export type WebhookIngestResult =
  | { status: "processed"; eventId: number }
  | { status: "duplicate"; webhookId: string }
  | { status: "invalid_signature" }
  | { status: "store_not_found"; shopDomain: string }
  | { status: "failed"; error: string };

/**
 * The outcome of ADMITTING a delivery — everything up to and including the
 * durable insert, and nothing after it.
 *
 * Split out from processing because the two have opposite failure semantics.
 * Admission decides what we tell SHOPLINE: once we answer 2xx it stops
 * retrying and the delivery is ours forever, so nothing may be acknowledged
 * before it is on disk. Processing decides what we do next, can be retried
 * from the stored row, and must never hold up the 5-second ack budget.
 */
export type WebhookAdmission =
  | { status: "admitted"; eventId: number; organizationId: number; slStoreId: number; topic: string; payload: unknown }
  | { status: "duplicate"; webhookId: string }
  | { status: "invalid_signature" }
  | { status: "store_not_found"; shopDomain: string };

/**
 * Admit a delivery: verify → resolve store → dedupe → insert as "pending".
 *
 * Stops at the insert on purpose. This is the boundary the HTTP handler must
 * `await` before answering 2xx, because SHOPLINE treats a 2xx as delivered and
 * will not send it again — so anything acknowledged before this returns is
 * simply lost. Throwing is the correct behaviour for an infrastructure failure
 * here: the caller turns it into a retryable status and SHOPLINE re-delivers.
 */
export async function admitWebhook(
  db: Db,
  webhook: InboundWebhook,
): Promise<WebhookAdmission> {
  // 1. Verify HMAC signature (tolerant: accepts hex or base64)
  const signatureValid = verifyWebhookHmac(
    webhook.rawBody,
    webhook.hmacSignature,
    ENV.shoplineAppSecret,
  );
  if (!signatureValid) {
    return { status: "invalid_signature" };
  }

  // 2. Parse payload early — billing (appsubscription/*) webhooks are
  //    app-scoped and identify the store by `handle` IN THE BODY rather than
  //    the X-Shopline-Shop-Domain header that store webhooks carry.
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(webhook.rawBody.toString("utf8"));
  } catch {
    payloadJson = null;
  }

  // 3. Resolve store: prefer the shop-domain header, fall back to payload handle.
  const headerHandle = webhook.shopDomain
    ? webhook.shopDomain.replace(/\.myshopline\.com$/i, "")
    : "";
  const bodyHandle =
    payloadJson && typeof payloadJson === "object"
      ? String((payloadJson as { handle?: unknown }).handle ?? "").replace(/\.myshopline\.com$/i, "")
      : "";
  const storeHandle = headerHandle || bodyHandle;

  if (!storeHandle) {
    return { status: "store_not_found", shopDomain: webhook.shopDomain };
  }

  const stores = await db
    .select()
    .from(slConnectorStores)
    .where(eq(slConnectorStores.storeHandle, storeHandle))
    .limit(1);

  if (stores.length === 0) {
    return { status: "store_not_found", shopDomain: webhook.shopDomain || storeHandle };
  }
  const store = stores[0];

  // 4. Idempotency check (unique on webhookId — spec says webhook-id is globally unique)
  const existing = await db
    .select({ id: slConnectorWebhookEvents.id })
    .from(slConnectorWebhookEvents)
    .where(eq(slConnectorWebhookEvents.webhookId, webhook.webhookId))
    .limit(1);

  if (existing.length > 0) {
    return { status: "duplicate", webhookId: webhook.webhookId };
  }

  // 5. Insert event record (pending)
  const [inserted] = await db.insert(slConnectorWebhookEvents).values({
    organizationId: store.organizationId,
    slStoreId: store.id,
    webhookId: webhook.webhookId,
    topic: webhook.topic,
    payloadJson,
    status: "pending",
    attempts: 0,
  });

  const eventId = (inserted as { insertId: number }).insertId;

  // The delivery is now durable. Everything past this line is recoverable from
  // the stored row, so the caller may safely acknowledge.
  return {
    status: "admitted",
    eventId,
    organizationId: store.organizationId,
    slStoreId: store.id,
    topic: webhook.topic,
    payload: payloadJson,
  };
}

/**
 * Process an already-admitted delivery and record the outcome on its row.
 *
 * Runs AFTER the acknowledgement, so it must never throw at the caller: a
 * failure here is recorded as `failed` on the event and is recoverable, unlike
 * a failure to admit, which would lose the delivery outright.
 */
export async function processAdmittedWebhook(
  db: Db,
  admitted: Extract<WebhookAdmission, { status: "admitted" }>,
): Promise<WebhookIngestResult> {
  try {
    await processWebhookEvent(
      db,
      admitted.organizationId,
      admitted.slStoreId,
      admitted.topic,
      admitted.payload,
    );

    await db
      .update(slConnectorWebhookEvents)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(slConnectorWebhookEvents.id, admitted.eventId));

    return { status: "processed", eventId: admitted.eventId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await db
      .update(slConnectorWebhookEvents)
      .set({
        status: "failed",
        attempts: 1,
        errorMessage,
      })
      .where(eq(slConnectorWebhookEvents.id, admitted.eventId));

    return { status: "failed", error: errorMessage };
  }
}

/**
 * Admit and then process, in one call.
 *
 * Retained for callers that legitimately want to block on the whole cycle —
 * the tRPC replay procedure and the tests. The HTTP receiver deliberately does
 * NOT use this: it must acknowledge between the two halves.
 */
export async function ingestWebhook(
  db: Db,
  webhook: InboundWebhook,
): Promise<WebhookIngestResult> {
  const admission = await admitWebhook(db, webhook);
  if (admission.status !== "admitted") return admission;
  return processAdmittedWebhook(db, admission);
}

/**
 * Route a verified webhook event to the appropriate handler.
 * Each handler is responsible for updating the reconciliation state.
 *
 * Topics aligned with the verified SHOPLINE webhook catalogue (spec §A7).
 *
 * Reconciliation is REAL-TIME: any topic that changes reconciliation state
 * schedules a debounced sync for the store (see realtimeSync.ts), so a
 * merchant sees results within seconds of a payment rather than waiting for
 * the 15-minute poll. Bursts are coalesced into a single run per store to stay
 * inside SHOPLINE's per-store rate limit. The scheduling call is deliberately
 * non-blocking — the HTTP layer has already acked 200.
 */
async function processWebhookEvent(
  db: Db,
  organizationId: number,
  slStoreId: number,
  topic: string,
  payload: unknown,
): Promise<void> {
  // Arm the debounced sync first: even if a per-topic handler below throws,
  // the reconciliation still happens (the event was real and state changed).
  scheduleReconciliation(organizationId, slStoreId, topic);

  switch (topic) {
    // ─── Order lifecycle ──────────────────────────────────────────────────
    case "orders/create":
      await handleOrderCreate(db, organizationId, slStoreId, payload);
      break;
    case "orders/paid":
      await handleOrderPaid(db, organizationId, slStoreId, payload);
      break;
    case "orders/updated":
      await handleOrderUpdated(db, organizationId, slStoreId, payload);
      break;
    case "orders/edited":
      await handleOrderEdited(db, organizationId, slStoreId, payload);
      break;
    case "orders/cancelled":
      await handleOrderCancelled(db, organizationId, slStoreId, payload);
      break;
    case "orders/delete":
      await handleOrderDeleted(db, organizationId, slStoreId, payload);
      break;

    // ─── Refund lifecycle ─────────────────────────────────────────────────
    case "refunds/create":
      await handleRefundCreated(db, organizationId, slStoreId, payload);
      break;
    case "refunds/update":
      await handleRefundUpdated(db, organizationId, slStoreId, payload);
      break;

    // ─── Transaction lifecycle ────────────────────────────────────────────
    case "order_transactions/create":
      await handleTransactionCreated(db, organizationId, slStoreId, payload);
      break;

    // ─── GDPR mandatory handlers ─────────────────────────────────────────
    case "customers/redact":
      await handleCustomerRedact(db, organizationId, slStoreId, payload);
      break;
    case "merchants/redact":
      await handleMerchantRedact(db, organizationId, slStoreId, payload);
      break;

    default:
      // Check if this is a billing/lifecycle topic
      if ((SHOPLINE_BILLING_WEBHOOK_TOPICS as readonly string[]).includes(topic)) {
        await processBillingWebhook(
          db,
          organizationId,
          slStoreId,
          topic,
          (payload ?? {}) as Record<string, unknown>,
        );
      } else {
        // Unknown topic — log and ignore (return 200 to SHOPLINE to prevent retries)
        console.warn(`[SHOPLINE] Unhandled webhook topic: ${topic}`);
      }
  }
}

// ─── Order handlers ─────────────────────────────────────────────────────────

async function handleOrderCreate(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const order = payload as { id?: string; name?: string };
  console.info(
    `[SHOPLINE] Order created: org=${organizationId} store=${slStoreId} orderId=${order?.id} name=${order?.name}`,
  );
}

async function handleOrderPaid(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  // Reconciliation is scheduled centrally in processWebhookEvent (debounced).
  const order = payload as { id?: string; name?: string; current_total_price_set?: unknown };
  console.info(
    `[SHOPLINE] Order paid: org=${organizationId} store=${slStoreId} orderId=${order?.id} name=${order?.name}`,
  );
}

async function handleOrderUpdated(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const order = payload as { id?: string; financial_status?: string };
  console.info(
    `[SHOPLINE] Order updated: org=${organizationId} store=${slStoreId} orderId=${order?.id} status=${order?.financial_status}`,
  );
}

async function handleOrderEdited(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const order = payload as { id?: string };
  console.info(
    `[SHOPLINE] Order edited: org=${organizationId} store=${slStoreId} orderId=${order?.id}`,
  );
}

async function handleOrderCancelled(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const order = payload as { id?: string; name?: string };
  console.info(
    `[SHOPLINE] Order cancelled: org=${organizationId} store=${slStoreId} orderId=${order?.id} name=${order?.name}`,
  );
  // The scheduled sync re-reconciles this order; any resulting mismatch is
  // classified by the retail taxonomy (e.g. retail_void_not_reversed).
}

async function handleOrderDeleted(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const order = payload as { id?: string };
  console.info(
    `[SHOPLINE] Order deleted: org=${organizationId} store=${slStoreId} orderId=${order?.id}`,
  );
}

// ─── Refund handlers ────────────────────────────────────────────────────────

async function handleRefundCreated(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const refund = payload as { id?: string; order_id?: string };
  console.info(
    `[SHOPLINE] Refund created: org=${organizationId} store=${slStoreId} refundId=${refund?.id} orderId=${refund?.order_id}`,
  );
  // The refund leg is matched by the scheduled sync; an uncredited refund
  // surfaces as retail_refund_not_settled from the taxonomy.
}

async function handleRefundUpdated(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const refund = payload as { id?: string; order_id?: string };
  console.info(
    `[SHOPLINE] Refund updated: org=${organizationId} store=${slStoreId} refundId=${refund?.id} orderId=${refund?.order_id}`,
  );
}

// ─── Transaction handler ────────────────────────────────────────────────────

async function handleTransactionCreated(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const tx = payload as { id?: string; order_id?: string; kind?: string; status?: string };
  console.info(
    `[SHOPLINE] Transaction created: org=${organizationId} store=${slStoreId} txId=${tx?.id} orderId=${tx?.order_id} kind=${tx?.kind} status=${tx?.status}`,
  );
  // Reconciliation is scheduled centrally in processWebhookEvent (debounced).
}

// ─── GDPR handlers (mandatory for App Store review) ─────────────────────────

/**
 * customers/redact — SHOPLINE requests deletion of customer PII.
 * Per spec §A7: respond 200, complete within 30 days.
 * We delete customer-identifying data from our webhook event payloads.
 */
async function handleCustomerRedact(
  _db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const request = payload as { customer?: { id?: string; email?: string }; shop_domain?: string };
  console.info(
    `[SHOPLINE] GDPR customers/redact: org=${organizationId} store=${slStoreId} customerId=${request?.customer?.id}`,
  );
  // Phase 1: log the request. Phase 2: integrate with dataDeletionRequests flow.
  // The actual PII scrub from webhook payloads will be handled by the data retention job.
}

/**
 * merchants/redact — SHOPLINE requests full merchant data deletion (uninstall + purge).
 * Per spec §A7: respond 200, complete within 30 days.
 * This also triggers connector deactivation (same as app uninstall).
 */
async function handleMerchantRedact(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const request = payload as { shop_domain?: string };
  console.info(
    `[SHOPLINE] GDPR merchants/redact: org=${organizationId} store=${slStoreId} domain=${request?.shop_domain}`,
  );

  // Mark store as uninstalled and delete token (same as app uninstall)
  await db
    .update(slConnectorStores)
    .set({ status: "uninstalled", uninstalledAt: new Date() })
    .where(
      and(
        eq(slConnectorStores.id, slStoreId),
        eq(slConnectorStores.organizationId, organizationId),
      ),
    );

  await deleteToken(db, slStoreId);

  // Phase 2: schedule full data purge (webhook events, synced transactions, etc.)
  // within 30 days per GDPR requirement.
}

/**
 * Maximum processing attempts before an event is parked in the DLQ.
 *
 * Three, not more: a delivery that has failed three times is failing for a
 * reason a fourth attempt will not change, and an event retried forever is a
 * queue that never drains and an alert nobody reads.
 */
export const WEBHOOK_MAX_ATTEMPTS = 3;

/**
 * Don't touch an event younger than this — the receiver acknowledges and
 * processes on the same tick, so anything newer is very likely still in flight.
 * Replaying it would double-process a delivery that was about to succeed.
 */
export const WEBHOOK_REPLAY_GRACE_MS = 5 * 60_000;

export type WebhookReplaySummary = {
  examined: number;
  processed: number;
  failed: number;
  movedToDlq: number;
  /** Rows another worker claimed first — expected, not an error. */
  skipped: number;
};

/**
 * Re-process deliveries that were admitted but never finished.
 *
 * Storing the event before acknowledging makes the delivery OURS; it does not
 * make it done. Two ways a row is left behind, both invisible without this:
 * the process exits between the ack and the `setImmediate` callback, leaving it
 * `pending` forever; or processing throws and it is recorded `failed` and never
 * looked at again. SHOPLINE will not redeliver after a 2xx, so nothing else is
 * coming — subscription lifecycle, refunds and reconciliation state simply stay
 * stale.
 *
 * Runs inside the existing 15-minute sync cycle rather than on a cron of its
 * own, deliberately: a recovery path that depends on someone remembering to
 * configure a schedule is a recovery path that is not there.
 */
export async function replayStalledWebhookEvents(
  db: Db,
  opts: { limit?: number; graceMs?: number } = {},
): Promise<WebhookReplaySummary> {
  const limit = opts.limit ?? 50;
  const cutoff = new Date(Date.now() - (opts.graceMs ?? WEBHOOK_REPLAY_GRACE_MS));

  const stalled = await db
    .select()
    .from(slConnectorWebhookEvents)
    .where(
      and(
        inArray(slConnectorWebhookEvents.status, ["pending", "failed"]),
        lt(slConnectorWebhookEvents.attempts, WEBHOOK_MAX_ATTEMPTS),
        lt(slConnectorWebhookEvents.receivedAt, cutoff),
      ),
    )
    .limit(limit);

  const summary: WebhookReplaySummary = {
    examined: stalled.length,
    processed: 0,
    failed: 0,
    movedToDlq: 0,
    skipped: 0,
  };

  for (const event of stalled) {
    const observedAttempts = event.attempts ?? 0;
    const attempts = observedAttempts + 1;

    // CLAIM the row before doing anything with it.
    //
    // Selecting and then processing is a read-modify-write across two
    // statements, and nothing stops a second scheduled sync — another Railway
    // instance, or an operator hitting the endpoint by hand — from selecting
    // the same row in between. Both would then run the side effect, which for
    // an `appsubscription/paid` event means applying the billing update twice,
    // and the outcome writes would race afterwards so a success could be
    // overwritten with `failed` or `dlq`.
    //
    // The attempt counter doubles as the lease: the UPDATE only matches while
    // the row still shows the count we read, so exactly one worker can move it
    // forward and the loser sees affectedRows = 0 and moves on.
    const claim = await db
      .update(slConnectorWebhookEvents)
      .set({ attempts })
      .where(
        and(
          eq(slConnectorWebhookEvents.id, event.id),
          eq(slConnectorWebhookEvents.attempts, observedAttempts),
          inArray(slConnectorWebhookEvents.status, ["pending", "failed"]),
        ),
      );

    const claimed = (claim as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
    if (claimed === 0) {
      summary.skipped += 1;
      continue;
    }

    // Every outcome write below is also conditional on still holding the claim,
    // so a slow worker cannot overwrite a newer attempt's result.
    const heldClaim = and(
      eq(slConnectorWebhookEvents.id, event.id),
      eq(slConnectorWebhookEvents.attempts, attempts),
    );

    try {
      await processWebhookEvent(
        db,
        event.organizationId,
        event.slStoreId,
        event.topic,
        event.payloadJson,
      );
      await db
        .update(slConnectorWebhookEvents)
        .set({ status: "processed", processedAt: new Date() })
        .where(heldClaim);
      summary.processed += 1;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;
      await db
        .update(slConnectorWebhookEvents)
        .set({ status: exhausted ? "dlq" : "failed", errorMessage })
        .where(heldClaim);
      if (exhausted) {
        summary.movedToDlq += 1;
        console.error(
          `[shopline-webhook] event ${event.id} (${event.topic}) exhausted ${WEBHOOK_MAX_ATTEMPTS} attempts — moved to DLQ:`,
          errorMessage,
        );
      } else {
        summary.failed += 1;
      }
    }
  }

  return summary;
}
