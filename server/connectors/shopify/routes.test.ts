/**
 * The retired authorization-code install path.
 *
 * Installation and reconnection are Shopify-managed (managedInstall.ts). The
 * two old routes stay mounted only to refuse: the install route starts no
 * authorization-code grant, and the callback redeems no code, even one that
 * arrives complete and correctly signed. Both answer before the database or
 * the network is touched.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => {
    throw new Error("the retired install path must not touch the database");
  }),
}));

import type express from "express";
import { getDb } from "../../db";
import { SHOPIFY_OAUTH_CALLBACK_PATH, SHOPIFY_RETIRED_INSTALL_PATH } from "./paths";
import { createShopifyRouter } from "./routes";

const SHOP = "merchant.myshopify.com";

type Handler = (req: express.Request, res: express.Response) => unknown;
type Layer = { route?: { path: string; stack: Array<{ handle: Handler }> } };

/** The handler Express would run for a path (Router internals, test-only). */
function handlerFor(path: string): Handler {
  const layer = (createShopifyRouter() as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === path);
  if (!layer?.route) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}

function fakeRes() {
  return {
    location: "",
    statusCode: 0,
    cookies: {} as Record<string, string>,
    cleared: [] as string[],
    redirect(code: number, url: string) {
      this.statusCode = code;
      this.location = url;
      return this;
    },
    cookie(name: string, value: string) {
      this.cookies[name] = value;
      return this;
    },
    clearCookie(name: string) {
      this.cleared.push(name);
      return this;
    },
  };
}

/** What Shopify would deliver to the callback after a grant: a code, signed. */
function signedGrant(): express.Request {
  const params: Record<string, string> = { code: "auth-code", shop: SHOP, state: "some-state", timestamp: "1790000000" };
  const message = Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join("&");
  params.hmac = crypto.createHmac("sha256", "client-secret").update(message).digest("hex");
  return { query: params, headers: { cookie: "shopify_oauth_flow=some-state" } } as unknown as express.Request;
}

const reason = (location: string) => new URL(location, "https://x").searchParams.get("reason");

let network: MockInstance<typeof fetch>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("the retired install path must not call out"));
});
afterEach(() => vi.restoreAllMocks());

describe("when a merchant follows an old install link", () => {
  it("should start no authorization-code grant, and say where installation happens now", async () => {
    const res = fakeRes();

    await handlerFor(SHOPIFY_RETIRED_INSTALL_PATH)({ query: { shop: SHOP }, headers: {} } as unknown as express.Request, res as never);

    expect(res.statusCode).toBe(302);
    expect(res.location).toBe("/shopify/error?reason=managed_install_only");
    expect(res.cookies).toEqual({});
    expect(getDb).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("should answer the same whatever the shop parameter holds", async () => {
    for (const query of [{}, { shop: "attacker.example" }, { shop: ["a", "b"] }]) {
      const res = fakeRes();
      await handlerFor(SHOPIFY_RETIRED_INSTALL_PATH)({ query, headers: {} } as unknown as express.Request, res as never);
      expect(reason(res.location)).toBe("managed_install_only");
    }
  });
});

describe("when Shopify delivers an authorization code to the callback", () => {
  it("should redeem nothing, even a complete and correctly signed grant", async () => {
    const res = fakeRes();

    await handlerFor(SHOPIFY_OAUTH_CALLBACK_PATH)(signedGrant(), res as never);

    expect(reason(res.location)).toBe("managed_install_only");
    // No exchange, no lease, no onboarding: nothing reaches Shopify or the database.
    expect(network).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("should clear a flow cookie a browser still holds from the old path", async () => {
    const res = fakeRes();

    await handlerFor(SHOPIFY_OAUTH_CALLBACK_PATH)(signedGrant(), res as never);

    expect(res.cleared).toEqual(["shopify_oauth_flow"]);
  });
});

describe("the routes shopify.app.toml names", () => {
  it("should still answer at exactly the paths Shopify was given", () => {
    // The callback stays listed as the redirect allow-list the CLI requires.
    expect(() => handlerFor(SHOPIFY_OAUTH_CALLBACK_PATH)).not.toThrow();
    expect(() => handlerFor(SHOPIFY_RETIRED_INSTALL_PATH)).not.toThrow();
  });
});
