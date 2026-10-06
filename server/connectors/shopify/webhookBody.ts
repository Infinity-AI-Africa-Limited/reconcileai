/**
 * The Shopify webhook body, read as bytes with its own limit — BEFORE the
 * application's global JSON parser.
 *
 * The global parser accepts 50 MB and parses it as JSON, and it runs before any
 * route. A webhook is authenticated only by the HMAC over its raw bytes, so an
 * unauthenticated POST to this path used to be parsed up to 50 MB before the
 * HMAC could refuse it. Here the body is only buffered, never parsed, up to a
 * limit sized for real payloads; the webhook handler verifies the HMAC first and
 * parses afterwards. Having consumed the stream, this parser also makes the
 * global one skip the request (body-parser honours `req._body`).
 *
 * Mount with `app.use(shopifyWebhookRawBody())` ahead of `express.json`.
 */
import express from "express";
import { SHOPIFY_WEBHOOK_PATH } from "./paths";

export { SHOPIFY_WEBHOOK_PATH };

/**
 * Comfortably above a real delivery: an order payload carries each line item,
 * fulfilment and refund in full, and even a very large order stays well inside
 * this. A delivery over it is refused with 413 and logged; the scheduled order
 * sync still fetches that order from the Admin API, so nothing is lost.
 */
export const SHOPIFY_WEBHOOK_MAX_BYTES = 10 * 1024 * 1024;

export function shopifyWebhookRawBody(): express.Router {
  const router = express.Router();
  router.post(
    SHOPIFY_WEBHOOK_PATH,
    express.raw({
      // Every content type: the HMAC is over the bytes, whatever they claim to be.
      type: () => true,
      limit: SHOPIFY_WEBHOOK_MAX_BYTES,
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
    (_req, _res, next) => next(),
  );
  router.use(
    SHOPIFY_WEBHOOK_PATH,
    (error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if ((error as { type?: unknown })?.type === "entity.too.large") {
        console.warn("[shopify-webhook] delivery refused: body over the limit", {
          code: "webhook_body_too_large",
          limitBytes: SHOPIFY_WEBHOOK_MAX_BYTES,
        });
        return res.status(413).json({ error: "payload_too_large" });
      }
      return next(error);
    },
  );
  return router;
}
