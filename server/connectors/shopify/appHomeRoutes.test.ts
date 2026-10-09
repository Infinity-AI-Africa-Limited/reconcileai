import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createShopifyAppHomeRouter,
  SHOPIFY_APP_BRIDGE_SCRIPT,
  withShopifyAppBridge,
  type ShopifyAppHomeRouterDeps,
} from "./appHomeRoutes";

const servers: Array<ReturnType<express.Express["listen"]>> = [];

/** A built shell as Vite emits it: the bundle's module script sits in <head>. */
const BUILT_SHELL =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8" />' +
  '<script type="module" crossorigin src="/assets/index-abc.js"></script></head>' +
  '<body><div id="root"></div></body></html>';

async function start(deps: ShopifyAppHomeRouterDeps = { serveShell: false }) {
  const app = express();
  app.use(createShopifyAppHomeRouter(deps));
  app.get("*", (_req, res) => res.type("html").send("app shell"));
  const server = await new Promise<ReturnType<express.Express["listen"]>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("when the Shopify App Home document is served", () => {
  it("should let only Shopify Admin and the named store frame it, on /shopify/app only, never with X-Frame-Options", async () => {
    const base = await start();
    const embedded = await fetch(`${base}/shopify/app?shop=merchant.myshopify.com&host=abc`);
    const ordinary = await fetch(`${base}/shopify/error`);

    expect(embedded.headers.get("content-security-policy")).toBe(
      "frame-ancestors https://merchant.myshopify.com https://admin.shopify.com",
    );
    expect(embedded.headers.get("x-frame-options")).toBeNull();
    expect(ordinary.headers.get("content-security-policy")).toBeNull();
  });

  it("should never let every myshopify.com storefront frame it", async () => {
    const base = await start();
    for (const shop of ["", "evil.example.com", "*.myshopify.com", "merchant.myshopify.com.evil.com"]) {
      const response = await fetch(`${base}/shopify/app?shop=${encodeURIComponent(shop)}`);
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors https://admin.shopify.com");
    }
    const unnamed = await fetch(`${base}/shopify/app`);
    expect(unnamed.headers.get("content-security-policy")).toBe("frame-ancestors https://admin.shopify.com");
  });

  it("should expose no API routes of its own — the workspace API is tRPC", async () => {
    const base = await start();
    const legacy = await fetch(`${base}/api/shopify/app-home/config`);
    expect(await legacy.text()).toBe("app shell");
  });
});

describe("when App Bridge is placed in the App Home shell", () => {
  it("should put the API key meta tag and a synchronous App Bridge script ahead of every other script", () => {
    const page = withShopifyAppBridge(BUILT_SHELL, "client-id")!;
    const bridge = page.indexOf(`<script src="${SHOPIFY_APP_BRIDGE_SCRIPT}"></script>`);

    expect(page.indexOf('<meta name="shopify-api-key" content="client-id" />')).toBeLessThan(bridge);
    expect(bridge).toBeGreaterThan(-1);
    expect(page.indexOf("<script")).toBe(bridge);
    expect(page).not.toMatch(/app-bridge\.js"[^>]*(async|defer|type=)/);
  });

  it("should escape the API key rather than trust it as markup", () => {
    expect(withShopifyAppBridge(BUILT_SHELL, '"><script>x</script>')).toContain(
      'content="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"',
    );
  });

  it("should serve the prepared shell in production, and fall through when it cannot", async () => {
    const served = await start({ serveShell: true, readShell: () => BUILT_SHELL, apiKey: () => "client-id" });
    const page = await fetch(`${served}/shopify/app?shop=merchant.myshopify.com`);
    expect(page.headers.get("content-security-policy")).toContain("https://merchant.myshopify.com");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain(SHOPIFY_APP_BRIDGE_SCRIPT);

    for (const deps of [
      { serveShell: false, readShell: () => BUILT_SHELL, apiKey: () => "client-id" },
      { serveShell: true, readShell: () => BUILT_SHELL, apiKey: () => "" },
      { serveShell: true, readShell: () => null, apiKey: () => "client-id" },
    ]) {
      const base = await start(deps);
      expect(await (await fetch(`${base}/shopify/app`)).text()).toBe("app shell");
    }
  });
});
