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
import { createHmac } from "crypto";
import { parse as parseUrl } from "url";
import { ENV } from "../../_core/env";
import {
  buildAuthorizationUrl,
  verifyCallbackSignature,
  exchangeCodeForToken,
} from "./auth";
import { verifyOAuthSignature, verifyWebhookHmac } from "./signature";
import { onboardShoplineMerchant } from "./onboarding";
import { ingestWebhook } from "./webhookHandler";
import { processGdprRequest, verifyGdprSignature, type GdprKind } from "./gdpr";
import { fetchStoreMetadata, registerWebhook as apiRegisterWebhook } from "./apiClient";
import type { ShoplineApiOptions } from "./apiClient";

/**
 * Signature verification for SHOPLINE's OAuth GET routes (install + callback).
 *
 * SHOPLINE's docs say: "Encode the query parameters of the request with URL
 * encoding. Then sort the query parameters in alphabetical order to create the
 * source string." Express hands us DECODED values, so the signed source string
 * may legitimately be either the decoded or the URL-encoded form. We therefore
 * try both encodings — and nothing else.
 *
 * Both candidates go through `verifyOAuthSignature`, which enforces the
 * ±10-minute timestamp window and compares in constant time.
 *
 * Deliberately NOT attempted (these were removed as unsafe):
 *   - Accepting a signature keyed on the APP KEY. The app key travels in the
 *     query string of the very request being verified, so anyone who sees an
 *     install URL could forge one. That is a complete authenticity bypass.
 *   - Accepting a signature while skipping the timestamp window. That removes
 *     replay protection: a captured install/callback URL would stay valid
 *     forever.
 *
 * Diagnostics are redacted and off by default (SHOPLINE_SIG_DEBUG): they log
 * which candidate matched and the signed message with sensitive values masked,
 * never secret material.
 */

/** Query keys whose values must never be written to logs. */
const SENSITIVE_QUERY_KEYS = new Set(["code", "sign", "customfield"]);

/** Build the sorted `k=v&k=v` source string SHOPLINE signs (minus `sign`). */
function signedMessage(params: Record<string, string>): string {
  const { sign: _sign, ...rest } = params;
  return Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
}

/** Same string, with sensitive values masked — safe to log. */
function redactedMessage(params: Record<string, string>): string {
  const { sign: _sign, ...rest } = params;
  return Object.keys(rest)
    .sort()
    .map((k) => `${k}=${SENSITIVE_QUERY_KEYS.has(k.toLowerCase()) ? "<redacted>" : rest[k]}`)
    .join("&");
}

/** First 8 chars of a signature — enough to compare, useless to replay. */
function sigPrefix(value: string | undefined): string {
  return value ? `${value.slice(0, 8)}…(${value.length})` : "<none>";
}

/** Parse the raw query string WITHOUT decoding values. */
function rawQueryParams(req: Request): Record<string, string> {
  const raw = parseUrl(req.originalUrl, false).query || "";
  const out: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.substring(0, eq)] = pair.substring(eq + 1);
  }
  return out;
}

/** Express-decoded query params as a flat string map. */
function decodedQueryParams(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export type SigOutcome = { valid: boolean; variant: "decoded" | "url-encoded" | null };

/**
 * Verify a SHOPLINE OAuth GET signature against both accepted encodings.
 * `context` only labels the log lines.
 */
function verifyShoplineGetSignature(req: Request, context: string): SigOutcome {
  const appSecret = ENV.shoplineAppSecret;
  if (!appSecret) {
    // Configuration fault, not an attack — always worth surfacing.
    console.error(
      `[shopline-sig:${context}] SHOPLINE_APP_SECRET is not configured; every signature will fail. Set it in the hosting environment.`,
    );
    return { valid: false, variant: null };
  }

  const decoded = decodedQueryParams(req);
  const rawEncoded = rawQueryParams(req);

  if (verifyOAuthSignature(decoded, appSecret)) {
    if (ENV.shoplineSigDebug) {
      console.log(`[shopline-sig:${context}] verified — variant=decoded`);
    }
    return { valid: true, variant: "decoded" };
  }

  if (verifyOAuthSignature(rawEncoded, appSecret)) {
    if (ENV.shoplineSigDebug) {
      console.log(`[shopline-sig:${context}] verified — variant=url-encoded`);
    }
    return { valid: true, variant: "url-encoded" };
  }

  // Failure diagnostics — redacted, and only when explicitly enabled.
  if (ENV.shoplineSigDebug) {
    const ts = Number(decoded["timestamp"]);
    const skewMs = Number.isFinite(ts)
      ? Date.now() - (ts < 1e12 ? ts * 1000 : ts)
      : Number.NaN;
    console.warn(
      `[shopline-sig:${context}] no candidate matched\n` +
        `  params            : ${Object.keys(decoded).sort().join(",")}\n` +
        `  message(decoded)  : ${redactedMessage(decoded)}\n` +
        `  message(encoded)  : ${redactedMessage(rawEncoded)}\n` +
        `  computed(decoded) : ${sigPrefix(hmacHexOf(appSecret, signedMessage(decoded)))}\n` +
        `  computed(encoded) : ${sigPrefix(hmacHexOf(appSecret, signedMessage(rawEncoded)))}\n` +
        `  received          : ${sigPrefix(decoded["sign"])}\n` +
        `  timestamp skew    : ${Number.isFinite(skewMs) ? `${Math.round(skewMs / 1000)}s` : "n/a"}\n` +
        `  secret configured : yes`,
    );
  } else {
    console.warn(
      `[shopline-sig:${context}] signature verification failed (set SHOPLINE_SIG_DEBUG=true for redacted diagnostics)`,
    );
  }

  return { valid: false, variant: null };
}

/** Hex HMAC helper used only to render a comparison prefix in diagnostics. */
function hmacHexOf(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

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

      // Verify the install request signature (both accepted encodings).
      const installSig = verifyShoplineGetSignature(req, "install");
      if (!installSig.valid) {
        // Narrowly-scoped diagnostic escape hatch. This route only REDIRECTS to
        // SHOPLINE's own authorization page — it mints no token, writes no data
        // and provisions no tenant — so allowing it through while the correct
        // signing variant is identified is low-risk and bounded. The callback,
        // webhooks and GDPR routes are never covered by this.
        if (ENV.shoplineInstallDiagnostic) {
          console.warn(
            `[shopline-install] SIGNATURE UNVERIFIED — proceeding because SHOPLINE_INSTALL_DIAGNOSTIC is enabled. ` +
              `This must be turned off once the correct signing variant is confirmed. handle=${handle}`,
          );
        } else {
          console.warn("[shopline-install] Invalid signature for handle:", handle);
          return res.status(403).json({ error: "Invalid signature" });
        }
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

      // Verify callback signature. ALWAYS STRICT — this route exchanges the
      // authorization code for an access token and provisions a tenant, so it
      // is never covered by the install diagnostic mode.
      if (!verifyShoplineGetSignature(req, "callback").valid) {
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

      // First install → pull 90 days of history in the background so the
      // merchant's dashboard has real results within minutes rather than
      // staying empty until the first scheduled sync. Fire-and-forget: the
      // merchant is redirected immediately, and a reconnection skips it
      // (the data is already there).
      if (!result.isReconnection) {
        void import("./syncOrchestrator")
          .then(({ runHistoricalBackfill }) =>
            runHistoricalBackfill({
              organizationId: result.organizationId,
              slStoreId: result.slStoreId,
            }),
          )
          .catch((err: unknown) => {
            console.error("[shopline-callback] Historical backfill failed:", err);
          });
      }

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

  // ─── GDPR / Mandatory Compliance Endpoints ────────────────────────────────
  // SHOPLINE's mandatory data-protection webhooks. The Partner Portal registers
  // one URL per subject; the canonical paths below match the portal config:
  //   POST /api/shopline/gdpr/customers-data-request  (customer access + redact)
  //   POST /api/shopline/gdpr/shop-data-request       (shop/merchant data deletion)
  // The older customers-redact / merchants-redact paths are kept as aliases so a
  // previously-registered URL keeps working. All share one signed handler.
  const gdprHandler = (endpointKind: GdprKind) => async (req: Request, res: Response) => {
    try {
      const rawBody =
        (req as Request & { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}));
      const hmacHeader = (req.headers["x-shopline-hmac-sha256"] as string) || "";

      // Signature is MANDATORY — without it a forged POST could trigger a shop
      // uninstall or a redaction. No/invalid signature ⇒ 401, no action taken.
      if (!verifyGdprSignature(rawBody, hmacHeader)) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const topic = (req.headers["x-shopline-topic"] as string) || undefined;
      const result = await processGdprRequest({
        rawBody,
        hmacHeader,
        topic,
        payload: (req.body ?? {}) as Parameters<typeof processGdprRequest>[0]["payload"],
        endpointKind,
      });

      // Always 200 once verified — SHOPLINE only needs the ack.
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error(`[shopline-gdpr] ${endpointKind} error:`, err);
      // Still 200 to avoid retries; the request is logged for manual follow-up.
      return res.status(200).json({ ok: true });
    }
  };

  // Canonical paths (match Partner Portal registration).
  router.post("/api/shopline/gdpr/customers-data-request", gdprHandler("customer_data_request"));
  router.post("/api/shopline/gdpr/shop-data-request", gdprHandler("shop_redact"));
  // Backward-compatible aliases.
  router.post("/api/shopline/gdpr/customers-redact", gdprHandler("customer_redact"));
  router.post("/api/shopline/gdpr/merchants-redact", gdprHandler("shop_redact"));

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
