/**
 * SHOPLINE Webhook Ingestion Handler
 *
 * Handles inbound webhook deliveries from SHOPLINE. All topics relevant to
 * payment reconciliation are processed here:
 *
 *   orders/paid          — new paid order (triggers reconciliation candidate)
 *   orders/updated       — order status change (may affect reconciliation)
 *   refunds/create       — refund issued (exception candidate: REFUND_NOT_CREDITED)
 *   payouts/paid         — settlement payout confirmed
 *   payouts/failed       — settlement payout failed (exception: SETTLEMENT_SHORTFALL)
 *   app/uninstalled      — merchant uninstalled app (cleanup tokens + store)
 *
 * Idempotency: each webhook has a unique `X-Shopline-Webhook-Id` header.
 * Duplicate deliveries are detected via the `sl_connector_webhook_events` table.
 *
 * DLQ: events that fail processing after 3 attempts are marked `dlq`.
 * A background job (Phase 2) will retry DLQ events.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
import { slConnectorWebhookEvents, slConnectorStores } from "../../../drizzle/connector_schema";
import { verifyWebhookHmac } from "./signature";
import { ENV } from "../../_core/env";

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
 * Ingest and process a SHOPLINE webhook delivery.
 * Returns a structured result — the HTTP handler should respond 200 in all
 * non-signature-failure cases (SHOPLINE retries on non-2xx responses).
 */
export async function ingestWebhook(
  db: Db,
  webhook: InboundWebhook,
): Promise<WebhookIngestResult> {
  // 1. Verify HMAC signature
  const signatureValid = verifyWebhookHmac(
    webhook.rawBody,
    webhook.hmacSignature,
    ENV.shoplineAppSecret,
  );
  if (!signatureValid) {
    return { status: "invalid_signature" };
  }

  // 2. Resolve store from shop domain
  const storeHandle = webhook.shopDomain.replace(".myshopline.com", "");
  const stores = await db
    .select()
    .from(slConnectorStores)
    .where(eq(slConnectorStores.storeHandle, storeHandle))
    .limit(1);

  if (stores.length === 0) {
    return { status: "store_not_found", shopDomain: webhook.shopDomain };
  }
  const store = stores[0];

  // 3. Idempotency check
  const existing = await db
    .select({ id: slConnectorWebhookEvents.id })
    .from(slConnectorWebhookEvents)
    .where(eq(slConnectorWebhookEvents.webhookId, webhook.webhookId))
    .limit(1);

  if (existing.length > 0) {
    return { status: "duplicate", webhookId: webhook.webhookId };
  }

  // 4. Parse payload
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(webhook.rawBody.toString("utf8"));
  } catch {
    payloadJson = null;
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

  // 6. Process the event
  try {
    await processWebhookEvent(db, store.organizationId, store.id, webhook.topic, payloadJson);

    await db
      .update(slConnectorWebhookEvents)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(slConnectorWebhookEvents.id, eventId));

    return { status: "processed", eventId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await db
      .update(slConnectorWebhookEvents)
      .set({
        status: "failed",
        attempts: 1,
        errorMessage,
      })
      .where(eq(slConnectorWebhookEvents.id, eventId));

    return { status: "failed", error: errorMessage };
  }
}

/**
 * Route a verified webhook event to the appropriate handler.
 * Each handler is responsible for updating the reconciliation state.
 */
async function processWebhookEvent(
  db: Db,
  organizationId: number,
  slStoreId: number,
  topic: string,
  payload: unknown,
): Promise<void> {
  switch (topic) {
    case "orders/paid":
      await handleOrderPaid(db, organizationId, slStoreId, payload);
      break;
    case "orders/updated":
      await handleOrderUpdated(db, organizationId, slStoreId, payload);
      break;
    case "refunds/create":
      await handleRefundCreated(db, organizationId, slStoreId, payload);
      break;
    case "payouts/paid":
      await handlePayoutPaid(db, organizationId, slStoreId, payload);
      break;
    case "payouts/failed":
      await handlePayoutFailed(db, organizationId, slStoreId, payload);
      break;
    case "app/uninstalled":
      await handleAppUninstalled(db, organizationId, slStoreId);
      break;
    default:
      // Unknown topic — log and ignore (do not throw, return 200 to SHOPLINE)
      console.warn(`[SHOPLINE] Unhandled webhook topic: ${topic}`);
  }
}

// ─── Individual event handlers ────────────────────────────────────────────────
// Phase 1: these handlers log the event and mark it for the reconciliation
// engine to pick up on the next run. Full real-time reconciliation triggering
// is a Phase 2 feature (requires the job queue integration).

async function handleOrderPaid(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  // TODO (Phase 2): enqueue a reconciliation job for this order
  const order = payload as { id?: string; order_number?: string; total_price?: string };
  console.info(
    `[SHOPLINE] Order paid: org=${organizationId} store=${slStoreId} orderId=${order?.id} total=${order?.total_price}`,
  );
}

async function handleOrderUpdated(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const order = payload as { id?: string; financial_status?: string };
  console.info(
    `[SHOPLINE] Order updated: org=${organizationId} store=${slStoreId} orderId=${order?.id} status=${order?.financial_status}`,
  );
}

async function handleRefundCreated(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const refund = payload as { id?: string; order_id?: string };
  console.info(
    `[SHOPLINE] Refund created: org=${organizationId} store=${slStoreId} refundId=${refund?.id} orderId=${refund?.order_id}`,
  );
}

async function handlePayoutPaid(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const payout = payload as { id?: string; amount?: string; currency?: string };
  console.info(
    `[SHOPLINE] Payout paid: org=${organizationId} store=${slStoreId} payoutId=${payout?.id} amount=${payout?.amount} ${payout?.currency}`,
  );
}

async function handlePayoutFailed(
  db: Db,
  organizationId: number,
  slStoreId: number,
  payload: unknown,
): Promise<void> {
  const payout = payload as { id?: string; amount?: string };
  console.warn(
    `[SHOPLINE] Payout FAILED: org=${organizationId} store=${slStoreId} payoutId=${payout?.id} amount=${payout?.amount}`,
  );
  // TODO (Phase 2): create a SETTLEMENT_SHORTFALL exception immediately
}

async function handleAppUninstalled(
  db: Db,
  organizationId: number,
  slStoreId: number,
): Promise<void> {
  // Mark store as uninstalled and delete token
  await db
    .update(slConnectorStores)
    .set({ status: "uninstalled", uninstalledAt: new Date() })
    .where(
      and(
        eq(slConnectorStores.id, slStoreId),
        eq(slConnectorStores.organizationId, organizationId),
      ),
    );

  // Token is deleted separately by the tokenStore.deleteToken call in the router
  console.info(`[SHOPLINE] App uninstalled: org=${organizationId} store=${slStoreId}`);
}
