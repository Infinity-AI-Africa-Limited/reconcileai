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

const PRIVACY_TOPICS = new Set(["customers/data_request", "customers/redact", "shop/redact"]);

type WebhookBody = {
  shop_id?: string | number;
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
 * Acknowledge Shopify webhook deliveries only after their HMAC has been checked.
 * Raw payloads (which may contain customer identifiers) are never retained in
 * this connector foundation; the durable ledger stores only a SHA-256 digest.
 */
export function createShopifyWebhookRouter(): express.Router {
  const router = express.Router();

  router.post("/api/webhooks/shopify", async (req, res) => {
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    const hmac = headerValue(req, "x-shopify-hmac-sha256");
    if (!rawBody || !verifyShopifyWebhookHmac(rawBody, hmac, ENV.shopifyClientSecret)) {
      return res.status(401).json({ error: "invalid_webhook_hmac" });
    }

    const topic = headerValue(req, "x-shopify-topic")?.toLowerCase();
    const shopDomain = normalizeShopDomain(headerValue(req, "x-shopify-shop-domain"));
    if (!topic || !shopDomain) return res.status(400).json({ error: "invalid_webhook_headers" });

    const db = await getDb();
    if (!db) return res.status(503).json({ error: "temporary_unavailable" });

    const payloadSha256 = sha256(rawBody);
    const webhookId = headerValue(req, "x-shopify-webhook-id") ?? `${topic}:${payloadSha256}`;
    const apiVersion = headerValue(req, "x-shopify-api-version");
    const [store] = await db
      .select()
      .from(shopifyConnectorStores)
      .where(eq(shopifyConnectorStores.shopDomain, shopDomain))
      .limit(1);

    try {
      await db
        .insert(shopifyWebhookEvents)
        .values({
          storeId: store?.id ?? null,
          organizationId: store?.organizationId ?? null,
          webhookId,
          topic,
          payloadSha256,
          apiVersion: apiVersion ?? null,
          status: "received",
        })
        .onDuplicateKeyUpdate({ set: { webhookId: sql`${shopifyWebhookEvents.webhookId}` } });

      if (!store) {
        // An app can receive a delayed uninstall/redaction delivery after its
        // store state is gone. It is safe to acknowledge, but no unknown tenant
        // is created from provider-controlled webhook fields.
        return res.status(200).json({ received: true, status: "unknown_store" });
      }

      if (topic === "app/uninstalled") {
        await db.transaction(async (tx) => {
          await tx
            .update(shopifyConnectorStores)
            .set({ status: "uninstalled", uninstalledAt: new Date(), lastWebhookAt: new Date() })
            .where(and(eq(shopifyConnectorStores.id, store.id), eq(shopifyConnectorStores.organizationId, store.organizationId)));
          await tx
            .delete(shopifyConnectorTokens)
            .where(and(eq(shopifyConnectorTokens.storeId, store.id), eq(shopifyConnectorTokens.organizationId, store.organizationId)));
          await tx
            .update(shopifyWebhookEvents)
            .set({ status: "processed", processedAt: new Date() })
            .where(eq(shopifyWebhookEvents.webhookId, webhookId));
          await createAuditLog(
            {
              organizationId: store.organizationId,
              userId: store.claimedByUserId ?? null,
              action: "shopify_store_uninstalled",
              entityType: "shopify_store",
              entityId: store.id,
              details: { shopDomain, provider: "shopify", webhookId },
            },
            tx,
          );
        });
        return res.status(200).json({ received: true, status: "processed" });
      }

      if (PRIVACY_TOPICS.has(topic)) {
        const body = parseWebhookBody(rawBody);
        // Privacy data is a transient input to identify the request. Hash IDs,
        // never email, phone, address or orders, before creating any evidence row.
        const subject = body?.data_request?.id ?? body?.customer?.id ?? body?.shop_id;
        const subjectHash = subject === undefined ? null : sha256(String(subject));
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
        return res.status(200).json({ received: true, status: "queued_for_privacy_control" });
      }

      // The order-led sync processor will claim only allowlisted order events in
      // the next phase. The foundation records all verified deliveries without
      // using them to mutate reconciliation data prematurely.
      await db
        .update(shopifyConnectorStores)
        .set({ lastWebhookAt: new Date() })
        .where(eq(shopifyConnectorStores.id, store.id));
      return res.status(200).json({ received: true, status: "recorded" });
    } catch (error) {
      console.error("[shopify-webhook] processing failed", {
        topic,
        shopDomain,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({ error: "temporary_unavailable" });
    }
  });

  return router;
}
