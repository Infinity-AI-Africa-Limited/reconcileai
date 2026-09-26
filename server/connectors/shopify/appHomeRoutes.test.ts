import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createShopifyAppHomeRouter, SHOPIFY_APP_FRAME_ANCESTORS } from "./appHomeRoutes";

const servers: Array<ReturnType<express.Express["listen"]>> = [];

async function start() {
  const app = express();
  app.use(createShopifyAppHomeRouter());
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
  it("should allow framing by Shopify Admin on /shopify/app only, never with X-Frame-Options", async () => {
    const base = await start();
    const embedded = await fetch(`${base}/shopify/app`);
    const ordinary = await fetch(`${base}/shopify/welcome`);

    expect(embedded.headers.get("content-security-policy")).toBe(SHOPIFY_APP_FRAME_ANCESTORS);
    expect(embedded.headers.get("x-frame-options")).toBeNull();
    expect(ordinary.headers.get("content-security-policy")).toBeNull();
  });

  it("should expose no API routes of its own — the workspace API is tRPC", async () => {
    const base = await start();
    const legacy = await fetch(`${base}/api/shopify/app-home/config`);
    expect(await legacy.text()).toBe("app shell");
  });
});
