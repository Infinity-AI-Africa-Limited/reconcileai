/**
 * SHOPLINE Express Routes
 *
 * These are raw Express routes (not tRPC) because SHOPLINE's OAuth flow and
 * webhook delivery require specific HTTP semantics:
 *
 *   GET  /api/shopline/install    — App Store install entry point
 *   GET  /api/shopline/callback   — OAuth callback (code exchange + onboarding)
 *   POST /api/webhooks/shopline   — Webhook receiver (signature-verified)
 *   POST /api/shopline/gdpr/customers-redact  — GDPR customer data erasure
 *   POST /api/shopline/gdpr/merchants-redact  — GDPR merchant data erasure
 *
 * These routes are registered in server/_core/index.ts.
 */
import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import { ENV } from "../../_core/env";
import {
  buildAuthorizationUrl,
  verifyCallbackSignature,
  exchangeCodeForToken,
} from "./auth";
import { verifyWebhookHmac } from "./signature";
import { onboardShoplineMerchant, handleShoplineUninstall } from "./onboarding";
import { ingestWebhook } from "./webhookHandler";
import { fetchStoreMetadata, registerWebhook as apiRegisterWebhook } from "./apiClient";
import type { ShoplineApiOptions } from "./apiClient";

/**
 * Create and return the Express router with all SHOPLINE routes.
 */
export function createShoplineRouter(): Router {
  const router = createRouter();

  // ─── Install Entry Point ──────────────────────────────────────────────────
  // SHOPLINE redirects the merchant here when they click "Install" in the App Store.
  // Query params: appkey, handle, timestamp, sign
  router.get("/api/shopline/install", async (req: Request, res: Response) => {
    try {
      const { handle, appkey, timestamp, sign } = req.query as Record<string, string>;

      if (!handle || !sign) {
        return res.status(400).json({ error: "Missing required parameters (handle, sign)" });
      }

      // Verify the install request signature
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") params[k] = v;
      }
      if (!verifyCallbackSignature(params)) {
        console.warn("[shopline-install] Invalid signature for handle:", handle);
        return res.status(403).json({ error: "Invalid signature" });
      }

      // Build the callback URL using the request's origin
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      const callbackUrl = `${protocol}://${host}/api/shopline/callback`;

      // Generate CSRF state token
      const state = `${handle}:${Date.now()}`;

      // Redirect merchant to SHOPLINE's authorization page
      const authUrl = buildAuthorizationUrl({
        storeHandle: handle,
        callbackUrl,
        state,
      });

      return res.redirect(302, authUrl);
    } catch (err) {
      console.error("[shopline-install] error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── OAuth Callback ───────────────────────────────────────────────────────
  // SHOPLINE redirects here after merchant grants permissions.
  // Query params: appkey, code, handle, timestamp, sign, customField (state)
  router.get("/api/shopline/callback", async (req: Request, res: Response) => {
    try {
      const { code, handle, sign, customField } = req.query as Record<string, string>;

      if (!code || !handle || !sign) {
        return res.status(400).json({ error: "Missing required parameters (code, handle, sign)" });
      }

      // Verify callback signature
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") params[k] = v;
      }
      if (!verifyCallbackSignature(params)) {
        console.warn("[shopline-callback] Invalid signature for handle:", handle);
        return res.status(403).json({ error: "Invalid signature" });
      }

      // Exchange code for access token
      const tokenResponse = await exchangeCodeForToken(handle, code);

      // Fetch store info using the new token
      const apiOpts: ShoplineApiOptions = { storeHandle: handle, accessToken: tokenResponse.accessToken };
      let storeInfo: { id?: string; name?: string; domain?: string; currency?: string; iana_timezone?: string } = {};
      try {
        const meta = await fetchStoreMetadata(apiOpts);
        storeInfo = { id: meta.id, name: meta.name, domain: meta.domain, currency: meta.currency, iana_timezone: meta.iana_timezone };
      } catch (err) {
        console.warn("[shopline-callback] Failed to fetch store info:", err);
      }

      // Onboard the merchant (auto-provision org, channels, etc.)
      const result = await onboardShoplineMerchant({
        store: {
          handle,
          storeId: storeInfo.id || handle,
          storeName: storeInfo.name || handle,
          domain: storeInfo.domain,
          currency: storeInfo.currency,
          ianaTimezone: storeInfo.iana_timezone,
          grantedScopes: tokenResponse.scope,
        },
        tokenResponse,
      });

      // Register webhooks for this store (fire-and-forget)
      registerWebhooksForStore(apiOpts).catch((err: unknown) => {
        console.error("[shopline-callback] Webhook registration failed:", err);
      });

      // Redirect to the ReconcileAI dashboard with success indicator
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      const dashboardUrl = `${protocol}://${host}/shopline/welcome?org=${result.organizationCode}&reconnect=${result.isReconnection}`;

      return res.redirect(302, dashboardUrl);
    } catch (err) {
      console.error("[shopline-callback] error:", err);
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      return res.redirect(302, `${protocol}://${host}/shopline/error?reason=install_failed`);
    }
  });

  // ─── Webhook Receiver ─────────────────────────────────────────────────────
  // POST /api/webhooks/shopline
  // Headers: X-Shopline-Hmac-SHA256, X-Shopline-Topic, X-Shopline-Webhook-Id,
  //          X-Shopline-Shop-Domain
  router.post("/api/webhooks/shopline", async (req: Request, res: Response) => {
    try {
      const hmacHeader = (req.headers["x-shopline-hmac-sha256"] as string) || "";
      const topic = (req.headers["x-shopline-topic"] as string) || "";
      const webhookId = (req.headers["x-shopline-webhook-id"] as string) || "";
      const shopDomain = (req.headers["x-shopline-shop-domain"] as string) || "";

      if (!hmacHeader || !topic || !webhookId) {
        return res.status(400).json({ error: "Missing required webhook headers" });
      }

      // Get raw body for signature verification
      const rawBody =
        (req as Request & { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}));

      // Verify webhook signature
      const webhookSecret = ENV.shoplineAppSecret; // Webhook secret = app secret per spec
      if (!verifyWebhookHmac(rawBody, hmacHeader, webhookSecret)) {
        console.warn("[shopline-webhook] Invalid HMAC for webhook:", webhookId);
        return res.status(401).json({ error: "Invalid signature" });
      }

      // Process the webhook event (async — return 200 immediately)
      const { getDb } = await import("../../db");
      const db = await getDb();
      if (db) {
        ingestWebhook(db, {
          webhookId,
          topic,
          hmacSignature: hmacHeader,
          shopDomain,
          rawBody,
        }).catch((err: unknown) => {
          console.error("[shopline-webhook] Processing error:", err);
        });
      }

      // Always return 200 quickly to prevent SHOPLINE retries
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[shopline-webhook] error:", err);
      return res.status(200).json({ ok: true }); // Still 200 to prevent retries
    }
  });

  // ─── GDPR: Customer Data Erasure ──────────────────────────────────────────
  // POST /api/shopline/gdpr/customers-redact
  // SHOPLINE sends this when a customer requests their data be erased.
  router.post("/api/shopline/gdpr/customers-redact", async (req: Request, res: Response) => {
    try {
      const rawBody =
        (req as Request & { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}));

      const hmacHeader = (req.headers["x-shopline-hmac-sha256"] as string) || "";
      if (hmacHeader && !verifyWebhookHmac(rawBody, hmacHeader, ENV.shoplineAppSecret)) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const { shop_domain, customer } = req.body ?? {};
      console.log(
        `[shopline-gdpr] Customer redact request: shop=${shop_domain}, customer_id=${customer?.id}`,
      );

      // ReconcileAI stores transaction data by organization, not by individual customer.
      // For GDPR compliance, we log the request. Actual PII is not stored in transaction
      // records (only amounts, refs, dates). If customer email/name is stored in rawData,
      // a background job will scrub it.
      // TODO: Implement rawData PII scrubbing for the affected customer

      return res.status(200).json({ ok: true, message: "Customer redact acknowledged" });
    } catch (err) {
      console.error("[shopline-gdpr] customers-redact error:", err);
      return res.status(200).json({ ok: true });
    }
  });

  // ─── GDPR: Merchant Data Erasure ──────────────────────────────────────────
  // POST /api/shopline/gdpr/merchants-redact
  // SHOPLINE sends this 48h after a merchant uninstalls the app.
  router.post("/api/shopline/gdpr/merchants-redact", async (req: Request, res: Response) => {
    try {
      const rawBody =
        (req as Request & { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}));

      const hmacHeader = (req.headers["x-shopline-hmac-sha256"] as string) || "";
      if (hmacHeader && !verifyWebhookHmac(rawBody, hmacHeader, ENV.shoplineAppSecret)) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const { shop_domain } = req.body ?? {};
      console.log(`[shopline-gdpr] Merchant redact request: shop=${shop_domain}`);

      // Mark the store as uninstalled and begin data retention countdown
      if (shop_domain) {
        const handle = shop_domain.replace(/\.myshopline\.com$/, "");
        await handleShoplineUninstall(handle);
      }

      return res.status(200).json({ ok: true, message: "Merchant redact acknowledged" });
    } catch (err) {
      console.error("[shopline-gdpr] merchants-redact error:", err);
      return res.status(200).json({ ok: true });
    }
  });

  return router;
}

// ─── Helper: Register webhooks for a newly installed store ──────────────────
async function registerWebhooksForStore(
  opts: ShoplineApiOptions,
): Promise<void> {
  const { SHOPLINE_WEBHOOK_TOPICS } = await import("../../../shared/shoplineConstants");

  // Build the webhook callback URL
  // In production this should be the public domain; for now use the app's configured URL
  const appUrl = process.env.APP_URL || process.env.VITE_APP_URL || "";
  if (!appUrl) {
    console.warn("[shopline-webhooks] APP_URL not set — skipping webhook registration");
    return;
  }

  const callbackUrl = `${appUrl}/api/webhooks/shopline`;

  for (const topic of SHOPLINE_WEBHOOK_TOPICS) {
    try {
      await apiRegisterWebhook(opts, topic, callbackUrl);
    } catch (err) {
      console.error(`[shopline-webhooks] Failed to register ${topic}:`, err);
    }
  }
}
