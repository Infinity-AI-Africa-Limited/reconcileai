import express from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  shopifyConnectorStores,
  shopifyConnectorTokens,
  shopifyPrivacyRequests,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import { ENV } from "../../_core/env";
import { createAuditLog, getDb } from "../../db";
import { normalizeShopDomain, sha256, verifyShopifyWebhookHmac } from "./auth";
import { enqueueShopifyWebhookSync } from "./syncOrchestrator";
import { admitShopifyShopRedaction } from "./redaction";

const PRIVACY_TOPICS = new Set(["customers/data_request", "customers/redact", "shop/redact"]);
export const SHOPIFY_ORDER_TRIGGER_TOPICS = new Set([
  "orders/create",
  "orders/paid",
  "orders/cancelled",
  "orders/edited",
  "orders/updated",
]);

/** Deliveries already handled; a redelivery of one is acknowledged without being re-applied. */
const SETTLED_STATUSES = new Set(["processed", "ignored"]);

type WebhookBody = {
  shop_id?: string | number;
  /** Compliance topics name the shop in the body… */
  shop_domain?: string;
  /** …and `app/uninstalled` carries the Shop resource. */
  myshopify_domain?: string | null;
  data_request?: { id?: string | number };
  customer?: { id?: string | number };
};

function headerValue(req: express.Request, key: string): string | undefined {
  const value = req.header(key);
  return value === undefined ? undefined : value;
}

function parseWebhookBody(raw: Buffer): WebhookBody | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as WebhookBody) : null;
  } catch {
    return null;
  }
}

/**
 * The shop the SIGNED body says it is about, if it says. The HMAC covers the
 * body only; `X-Shopify-Shop-Domain` is an unsigned header, and it is what
 * selects the store to act on. A body that names a different shop than the
 * header is refused rather than applied to the header's store.
 */
export function declaredShopDomain(body: WebhookBody | null): string | null {
  const declared = body?.shop_domain ?? body?.myshopify_domain ?? null;
  return typeof declared === "string" ? normalizeShopDomain(declared) ?? declared.toLowerCase() : null;
}

/**
 * True when an uninstall was triggered before the store's latest authorization.
 * Shopify retries a failed delivery for up to 48 hours, so an uninstall that
 * failed once can arrive after the merchant has reinstalled; applied then, it
 * would delete the new credentials of an installed app.
 */
export function isStaleUninstall(triggeredAtHeader: string | undefined, claimedAt: Date | null): boolean {
  return triggeredBeforeAuthorization(triggeredAtHeader, claimedAt);
}

/**
 * True when a delivery was triggered before the store's latest authorization.
 * A destructive topic — uninstall, shop redaction — triggered then is about the
 * PREVIOUS installation; applied after a reinstall it would destroy the new one.
 */
export function triggeredBeforeAuthorization(triggeredAtHeader: string | undefined, claimedAt: Date | null): boolean {
  if (!triggeredAtHeader || !claimedAt) return false;
  const triggeredAt = new Date(triggeredAtHeader);
  return !Number.isNaN(triggeredAt.getTime()) && triggeredAt < claimedAt;
}

let lastSecretWarningAt = 0;
function warnSecretMissing(): void {
  // Every delivery 401s without the secret — the SHOPLINE lesson (CLAUDE.md
  // §2B.9b) is that this must be a one-line diagnosis, not a hunt. Throttled so
  // Shopify's retries cannot flood the log.
  if (Date.now() - lastSecretWarningAt < 10 * 60_000) return;
  lastSecretWarningAt = Date.now();
  console.error("[shopify-webhook] SHOPIFY_CLIENT_SECRET is not configured — every delivery is being rejected");
}

/**
 * Acknowledge Shopify webhook deliveries only after their HMAC has been checked.
 * Raw payloads (which may contain customer identifiers) are never retained in
 * this connector foundation; the durable ledger stores only a SHA-256 digest.
 *
 * Everything after authentication runs inside one try: Express 4 does not catch
 * a rejected async handler, and this server has no `unhandledRejection`
 * handler, so a single database error escaping here would exit the process —
 * and Shopify would retry the delivery straight back into it.
 */
export async function handleShopifyWebhook(req: express.Request, res: express.Response) {
  if (!ENV.shopifyClientSecret) warnSecretMissing();
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  const hmac = headerValue(req, "x-shopify-hmac-sha256");
  if (!rawBody || !verifyShopifyWebhookHmac(rawBody, hmac, ENV.shopifyClientSecret)) {
    return res.status(401).json({ error: "invalid_webhook_hmac" });
  }

  const topic = headerValue(req, "x-shopify-topic")?.toLowerCase();
  const shopDomain = normalizeShopDomain(headerValue(req, "x-shopify-shop-domain"));
  if (!topic || !shopDomain) return res.status(400).json({ error: "invalid_webhook_headers" });

  const body = parseWebhookBody(rawBody);
  const declared = declaredShopDomain(body);
  if (declared !== null && declared !== shopDomain) {
    console.warn("[shopify-webhook] body names a different shop than the header", { topic, shopDomain });
    return res.status(400).json({ error: "shop_domain_mismatch" });
  }

  const payloadSha256 = sha256(rawBody);
  const webhookId = headerValue(req, "x-shopify-webhook-id") ?? `${topic}:${payloadSha256}`;
  const settle = async (status: "processed" | "ignored" | "failed", errorCode: string | null = null) => {
    const db = await getDb();
    await db
      ?.update(shopifyWebhookEvents)
      .set({ status, errorCode, processedAt: new Date() })
      .where(eq(shopifyWebhookEvents.webhookId, webhookId));
  };

  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: "temporary_unavailable" });

    const [store] = await db
      .select()
      .from(shopifyConnectorStores)
      .where(eq(shopifyConnectorStores.shopDomain, shopDomain))
      .limit(1);

    await db
      .insert(shopifyWebhookEvents)
      .values({
        storeId: store?.id ?? null,
        organizationId: store?.organizationId ?? null,
        webhookId,
        topic,
        payloadSha256,
        apiVersion: headerValue(req, "x-shopify-api-version") ?? null,
        status: "received",
      })
      .onDuplicateKeyUpdate({ set: { webhookId: sql`${shopifyWebhookEvents.webhookId}` } });

    const [event] = await db
      .select({ status: shopifyWebhookEvents.status })
      .from(shopifyWebhookEvents)
      .where(eq(shopifyWebhookEvents.webhookId, webhookId))
      .limit(1);
    // A settled receipt normally ends here. `shop/redact` does not: before
    // admission existed, a delivery was settled `processed` with no redaction
    // job and no fence, so "settled" does not prove it was admitted. Admission
    // is idempotent on its own terms (one job per store or request), so a
    // redelivery goes back through it instead.
    if (event && SETTLED_STATUSES.has(event.status) && topic !== "shop/redact") {
      return res.status(200).json({ received: true, status: "duplicate" });
    }

    if (!store) {
      // An app can receive a delayed uninstall/redaction delivery after its
      // store state is gone. It is safe to acknowledge, but no unknown tenant
      // is created from provider-controlled webhook fields.
      await settle("ignored", "unknown_store");
      return res.status(200).json({ received: true, status: "unknown_store" });
    }

    if (topic === "app/uninstalled") {
      if (isStaleUninstall(headerValue(req, "x-shopify-triggered-at"), store.claimedAt)) {
        await settle("ignored", "stale_uninstall");
        return res.status(200).json({ received: true, status: "ignored_stale" });
      }
      await db.transaction(async (tx) => {
        await tx
          .update(shopifyConnectorStores)
          .set({ status: "uninstalled", statusReason: "uninstalled", uninstalledAt: new Date(), lastWebhookAt: new Date() })
          .where(and(eq(shopifyConnectorStores.id, store.id), eq(shopifyConnectorStores.organizationId, store.organizationId)));
        await tx
          .delete(shopifyConnectorTokens)
          .where(and(eq(shopifyConnectorTokens.storeId, store.id), eq(shopifyConnectorTokens.organizationId, store.organizationId)));
        await tx
          .update(shopifyWebhookEvents)
          .set({ status: "processed", processedAt: new Date() })
          .where(eq(shopifyWebhookEvents.webhookId, webhookId));
      });
      // After the commit, never inside it: revoking credentials Shopify has
      // already revoked must not be undone because the audit write failed.
      try {
        await createAuditLog({
          organizationId: store.organizationId,
          userId: store.claimedByUserId ?? null,
          action: "shopify_store_uninstalled",
          entityType: "shopify_store",
          entityId: store.id,
          details: { shopDomain, provider: "shopify", webhookId },
        });
      } catch (error) {
        console.error("[shopify-webhook] AUDIT WRITE FAILED for an uninstall", {
          storeId: store.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return res.status(200).json({ received: true, status: "processed" });
    }

    if (PRIVACY_TOPICS.has(topic)) {
      // Privacy data is a transient input to identify the request. Hash IDs,
      // never email, phone, address or orders, before creating any evidence row.
      const subject = body?.data_request?.id ?? body?.customer?.id ?? body?.shop_id;
      const subjectHash = subject === undefined ? null : sha256(String(subject));

      if (topic === "shop/redact") {
        // Shopify retries a failed delivery for 48 hours. One triggered before
        // the merchant reinstalled is about the previous installation; admitting
        // it now would fence the new workspace and delete its credentials.
        if (triggeredBeforeAuthorization(headerValue(req, "x-shopify-triggered-at"), store.claimedAt)) {
          await settle("ignored", "stale_shop_redact");
          return res.status(200).json({ received: true, status: "ignored_stale" });
        }
        // Shopify's 2xx acknowledgement means this request was durably admitted,
        // not that the tenant was deleted. Admission creates a short-lived job,
        // fences new work, revokes credentials, and fails closed on any DB error.
        const admission = await db.transaction(async (tx) => {
          await tx
            .insert(shopifyPrivacyRequests)
            .values({
              storeId: store.id,
              organizationId: store.organizationId,
              topic: "shop/redact",
              requestHash: payloadSha256,
              subjectHash,
              status: "received",
            })
            .onDuplicateKeyUpdate({ set: { requestHash: sql`${shopifyPrivacyRequests.requestHash}` } });
          const admitted = await admitShopifyShopRedaction(tx, { store, requestHash: payloadSha256, webhookId });
          await tx
            .update(shopifyWebhookEvents)
            .set({ status: "processed", processedAt: new Date() })
            .where(eq(shopifyWebhookEvents.webhookId, webhookId));
          return admitted;
        });
        return res.status(200).json({ received: true, status: `shop_redact_${admission.status}` });
      }

      await db
        .insert(shopifyPrivacyRequests)
        .values({
          storeId: store.id,
          organizationId: store.organizationId,
          topic: topic as "customers/data_request" | "customers/redact" | "shop/redact",
          requestHash: payloadSha256,
          subjectHash,
          status: "received",
        })
        .onDuplicateKeyUpdate({ set: { requestHash: sql`${shopifyPrivacyRequests.requestHash}` } });
      await db
        .update(shopifyConnectorStores)
        .set({ lastWebhookAt: new Date() })
        .where(eq(shopifyConnectorStores.id, store.id));
      // The delivery is settled once the request is on the privacy ledger; the
      // request itself stays `received` there until it is completed.
      await settle("processed");
      return res.status(200).json({ received: true, status: "queued_for_privacy_control" });
    }

    if (SHOPIFY_ORDER_TRIGGER_TOPICS.has(topic)) {
      // The webhook body is a trigger only. No order/customer field is projected
      // from it; the worker re-reads the authoritative minimal record via Admin
      // GraphQL. enqueueShopifyWebhookSync requires BullMQ, so a successful return
      // proves durable admission. If Redis is unavailable, the catch below marks
      // this receipt failed and answers 503 for Shopify to retry — never 2xx on a
      // volatile in-process promise.
      await enqueueShopifyWebhookSync({
        storeId: store.id,
        organizationId: store.organizationId,
        webhookId,
      });
      await db
        .update(shopifyConnectorStores)
        .set({ lastWebhookAt: new Date() })
        .where(
          and(
            eq(shopifyConnectorStores.id, store.id),
            eq(shopifyConnectorStores.organizationId, store.organizationId),
          ),
        );
      return res.status(200).json({ received: true, status: "queued_for_order_sync" });
    }

    // Verified, but not a topic this bounded connector is allowed to act on.
    // Settle it as ignored rather than leaving an unclaimable receipt pending.
    await db
      .update(shopifyConnectorStores)
      .set({ lastWebhookAt: new Date() })
      .where(
        and(
          eq(shopifyConnectorStores.id, store.id),
          eq(shopifyConnectorStores.organizationId, store.organizationId),
        ),
      );
    await settle("ignored", "topic_not_allowlisted");
    return res.status(200).json({ received: true, status: "ignored_topic" });
  } catch (error) {
    console.error("[shopify-webhook] processing failed", {
      topic,
      shopDomain,
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await settle("failed", "processing_error");
    } catch {
      // The ledger is evidence, not the control; the 503 below makes Shopify retry.
    }
    return res.status(503).json({ error: "temporary_unavailable" });
  }
}

export function createShopifyWebhookRouter(): express.Router {
  const router = express.Router();
  router.post("/api/webhooks/shopify", handleShopifyWebhook);
  return router;
}
