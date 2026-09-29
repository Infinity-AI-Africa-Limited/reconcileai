import express from "express";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHOPIFY_WEBHOOK_MAX_BYTES, SHOPIFY_WEBHOOK_PATH, shopifyWebhookRawBody } from "./webhookBody";

const servers: Array<ReturnType<express.Express["listen"]>> = [];
const reached = vi.fn();

/** The production order: this parser, then the app-wide 50 MB JSON parser, then the routes. */
async function start() {
  const app = express();
  app.use(shopifyWebhookRawBody());
  app.use(
    express.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.post(SHOPIFY_WEBHOOK_PATH, (req, res) => {
    reached();
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    res.json({ bodyIsBuffer: Buffer.isBuffer(req.body), raw: rawBody?.toString("utf8") ?? null });
  });
  app.post("/api/other", (req, res) => res.json({ parsed: req.body }));
  const server = await new Promise<ReturnType<express.Express["listen"]>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  reached.mockReset();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("when a Shopify webhook arrives", () => {
  it("should hand the handler the exact bytes, never parsed by the global JSON parser", async () => {
    const base = await start();
    const body = '{"id": 820982911946154508, "note":"spacing  kept"}';

    const response = await fetch(`${base}${SHOPIFY_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(await response.json()).toEqual({ bodyIsBuffer: true, raw: body });
  });

  it("should keep the bytes whatever content type the request claims", async () => {
    const base = await start();
    const response = await fetch(`${base}${SHOPIFY_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });
    expect(await response.json()).toEqual({ bodyIsBuffer: true, raw: "not json" });
  });

  it("should refuse a body over its limit before any handler runs, and say so by code", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = await start();

    const response = await fetch(`${base}${SHOPIFY_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(SHOPIFY_WEBHOOK_MAX_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(reached).not.toHaveBeenCalled();
    expect(warned.mock.calls[0]?.[1]).toMatchObject({ code: "webhook_body_too_large" });
  });

  it("should be well under the global parser's 50 MB", () => {
    expect(SHOPIFY_WEBHOOK_MAX_BYTES).toBeLessThan(50 * 1024 * 1024);
  });
});

describe("when any other route is called", () => {
  it("should still be parsed as JSON by the global parser", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/other`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    expect(await response.json()).toEqual({ parsed: { a: 1 } });
  });
});

describe("when the server mounts its body parsers", () => {
  it("should mount the Shopify webhook parser before the global JSON parser", () => {
    const source = readFileSync(path.resolve(__dirname, "../../_core/index.ts"), "utf8");
    const webhookParser = source.indexOf("app.use(shopifyWebhookRawBody());");
    const globalParser = source.indexOf("express.json(");
    expect(webhookParser).toBeGreaterThan(-1);
    expect(globalParser).toBeGreaterThan(-1);
    expect(webhookParser).toBeLessThan(globalParser);
  });
});
