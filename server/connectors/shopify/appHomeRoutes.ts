import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ENV } from "../../_core/env";
import { normalizeShopDomain } from "./auth";
import { SHOPIFY_APP_HOME_PATH } from "./paths";

/**
 * The App Home DOCUMENT: its embed policy, and — in production — App Bridge
 * placed in the HTML itself. That is all that stays in Express: both are
 * properties of a page, not an API. The workspace's API is the tRPC
 * `shopifyAppHome` router (server/routers/shopifyAppHome.ts).
 */

export const SHOPIFY_ADMIN_ORIGIN = "https://admin.shopify.com";
export const SHOPIFY_APP_BRIDGE_SCRIPT = "https://cdn.shopify.com/shopifycloud/app-bridge.js";

/**
 * Who may frame this response: Shopify Admin, and the ONE store the request
 * names — never every `*.myshopify.com`. Storefronts live on that domain too,
 * and their themes run merchant-authored script, so a wildcard lets any store's
 * storefront frame the workspace. This is the value Shopify's own middleware
 * sets (`frame-ancestors https://${shop} https://admin.shopify.com`). Without a
 * valid `shop` only Shopify Admin may frame it; Admin always sends `shop`.
 */
export function shopifyAppFrameAncestors(shop: unknown): string {
  const domain = typeof shop === "string" ? normalizeShopDomain(shop) : null;
  return domain
    ? `frame-ancestors https://${domain} ${SHOPIFY_ADMIN_ORIGIN}`
    : `frame-ancestors ${SHOPIFY_ADMIN_ORIGIN}`;
}

/** Apply an embed policy only to App Home documents, never to the global SPA. */
export function shopifyAppFrameHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", shopifyAppFrameAncestors(req.query.shop));
  // Some hosting layers set this before application middleware. Shopify Admin
  // framing relies on CSP; a legacy DENY/SAMEORIGIN value would override it.
  res.removeHeader("X-Frame-Options");
  next();
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The app shell with App Bridge as the FIRST script, and the API key meta tag
 * before it — Shopify's documented contract for `app-bridge.js`: loaded from
 * its CDN, synchronously (no async, defer or module), ahead of any other
 * script. Vite puts the bundle's module script in `<head>`, so the tags go
 * immediately after the opening `<head>`. Null when the shell has no head.
 */
export function withShopifyAppBridge(html: string, apiKey: string): string | null {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) return null;
  const at = head.index + head[0].length;
  const tags =
    `<meta name="shopify-api-key" content="${escapeAttribute(apiKey)}" />` +
    `<script src="${SHOPIFY_APP_BRIDGE_SCRIPT}"></script>`;
  return html.slice(0, at) + tags + html.slice(at);
}

export interface ShopifyAppHomeRouterDeps {
  /** Test seam; production serves the built shell only when NODE_ENV is production. */
  serveShell?: boolean;
  /** Test seam; production reads the built `dist/public/index.html`. */
  readShell?: () => string | null;
  /** Test seam; production reads the deployment's SHOPIFY_CLIENT_ID. */
  apiKey?: () => string;
}

/**
 * The built shell, read once per process: it is a build artifact, fixed for the
 * life of a deploy. Resolved exactly as `serveStatic` resolves it — this module
 * is bundled into `dist/index.js`, so `import.meta.dirname` is `dist`.
 */
let builtShell: string | null | undefined;
function readBuiltShell(): string | null {
  if (builtShell === undefined) {
    try {
      builtShell = fs.readFileSync(path.resolve(import.meta.dirname, "public", "index.html"), "utf8");
    } catch {
      builtShell = null;
    }
  }
  return builtShell;
}

/**
 * Mounted before the static handler and Vite's HTML fallback (server/_core),
 * so the policy is on the response before either writes it.
 *
 * Outside production (Vite dev), or if the shell cannot be prepared, the
 * request falls through to the ordinary SPA shell and the page loads App Bridge
 * itself (client/src/lib/shopifyAppBridge.ts) — a fallback, not the contract.
 */
export function createShopifyAppHomeRouter(deps: ShopifyAppHomeRouterDeps = {}): express.Router {
  const router = express.Router();
  router.use(SHOPIFY_APP_HOME_PATH, shopifyAppFrameHeaders);

  const serveShell = deps.serveShell ?? ENV.isProduction;
  const readShell = deps.readShell ?? readBuiltShell;
  const apiKey = deps.apiKey ?? (() => ENV.shopifyClientId.trim());
  router.get([SHOPIFY_APP_HOME_PATH, `${SHOPIFY_APP_HOME_PATH}/`], (_req, res, next) => {
    if (!serveShell) return next();
    const key = apiKey();
    const shell = key ? readShell() : null;
    const page = shell ? withShopifyAppBridge(shell, key) : null;
    if (!page) return next();
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(page);
  });
  return router;
}
