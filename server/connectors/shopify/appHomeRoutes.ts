import express, { type NextFunction, type Request, type Response } from "express";

/**
 * The embed policy for the Shopify App Home DOCUMENT. This is all that stays in
 * Express: it is a response header on a page, not an API. The workspace's API
 * is the tRPC `shopifyAppHome` router (server/routers/shopifyAppHome.ts).
 */
export const SHOPIFY_APP_FRAME_ANCESTORS =
  "frame-ancestors https://admin.shopify.com https://*.myshopify.com";

/** Apply an embed policy only to App Home documents, never to the global SPA. */
export function shopifyAppFrameHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", SHOPIFY_APP_FRAME_ANCESTORS);
  // Some hosting layers set this before application middleware. Shopify Admin
  // framing relies on CSP; a legacy DENY/SAMEORIGIN value would override it.
  res.removeHeader("X-Frame-Options");
  next();
}

/**
 * Mounted before the static handler and Vite's HTML fallback (server/_core),
 * so the policy is on the response before either writes it.
 */
export function createShopifyAppHomeRouter(): express.Router {
  const router = express.Router();
  router.use("/shopify/app", shopifyAppFrameHeaders);
  return router;
}
