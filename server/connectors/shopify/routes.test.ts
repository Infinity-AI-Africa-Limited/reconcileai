import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("../../_core/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../_core/env")>();
  return {
    ...mod,
    ENV: { ...mod.ENV, shopifyClientId: "client-id", shopifyClientSecret: "client-secret", appUrl: "https://app.example", isProduction: false },
  };
});
vi.mock("../../_core/cookies", () => ({ getSessionCookieOptions: () => ({}) }));
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  exchangeAuthorizationCode: vi.fn(),
}));

import type express from "express";
import { getDb } from "../../db";
import { exchangeAuthorizationCode, signOAuthState } from "./auth";
import { callbackReasonFor, createShopifyRouter } from "./routes";
import { ShopifyOnboardingError, type ShopifyOnboardingErrorCode } from "./onboarding";
import { duplicateKeyError, scriptedDb } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const STATES = "shopify_oauth_states";

type Handler = (req: express.Request, res: express.Response) => unknown;
type Layer = { route?: { path: string; stack: Array<{ handle: Handler }> } };

/** The handler Express would run for a path (Router internals, test-only). */
function handlerFor(path: string): Handler {
  const layer = (createShopifyRouter() as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === path);
  if (!layer?.route) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}

function fakeRes() {
  const res = {
    location: "",
    cookies: {} as Record<string, string>,
    statusCode: 0,
    redirect(code: number, url: string) {
      this.statusCode = code;
      this.location = url;
      return this;
    },
    cookie(name: string, value: string) {
      this.cookies[name] = value;
      return this;
    },
    clearCookie() {
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send() {
      return this;
    },
  };
  return res;
}

/** A callback Shopify would send: HMAC over the params in code-unit order. */
function callbackRequest(oauthState: string, cookieState = oauthState, shop = SHOP) {
  const params: Record<string, string> = { code: "auth-code", shop, state: oauthState, timestamp: "1790000000" };
  const message = Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join("&");
  params.hmac = crypto.createHmac("sha256", "client-secret").update(message).digest("hex");
  return { query: params, headers: { cookie: `shopify_oauth_flow=${cookieState}` }, get: () => "app.example", protocol: "https" } as unknown as express.Request;
}

const reason = (location: string) => new URL(location, "https://x").searchParams.get("reason");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/shopify/install", () => {
  it("should redirect to the shop's authorize page with a signed state, writing nothing", async () => {
    const fake = scriptedDb();
    state.db = fake.db;
    const res = fakeRes();
    await handlerFor("/api/shopify/install")({ query: { shop: SHOP }, headers: {} } as unknown as express.Request, res as never);

    const url = new URL(res.location);
    expect(url.origin).toBe(`https://${SHOP}`);
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/shopify/callback");
    expect(url.searchParams.get("state")).toBe(res.cookies.shopify_oauth_flow);
    expect(fake.ops).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("should not consult X-Forwarded-For — there is no per-client state left to key", async () => {
    // Any number of distinct spoofed addresses is served identically and costs
    // no database write; the header is simply never read.
    state.db = scriptedDb().db;
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      const res = fakeRes();
      await handlerFor("/api/shopify/install")(
        { query: { shop: SHOP }, headers: { "x-forwarded-for": ip } } as unknown as express.Request,
        res as never,
      );
      expect(res.statusCode).toBe(302);
      expect(res.location).toContain(SHOP);
    }
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("GET /api/shopify/callback", () => {
  const signed = (shopDomain = SHOP) => signOAuthState({ shopDomain, secret: "client-secret", ttlMs: 10 * 60_000 }).state;

  it("should refuse a state issued for another shop before touching the database", async () => {
    const fake = scriptedDb();
    state.db = fake.db;
    const res = fakeRes();
    await handlerFor("/api/shopify/callback")(callbackRequest(signed("other.myshopify.com")), res as never);
    expect(reason(res.location)).toBe("expired_or_replayed");
    expect(fake.ops).toEqual([]);
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("should refuse a replayed state without exchanging the code a second time", async () => {
    const fake = scriptedDb({ insert: { [STATES]: [duplicateKeyError()] } });
    state.db = fake.db;
    const res = fakeRes();
    await handlerFor("/api/shopify/callback")(callbackRequest(signed()), res as never);
    expect(reason(res.location)).toBe("expired_or_replayed");
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("should record the state as consumed before exchanging the code", async () => {
    const fake = scriptedDb();
    state.db = fake.db;
    vi.mocked(exchangeAuthorizationCode).mockRejectedValueOnce(new Error("stop here"));
    await handlerFor("/api/shopify/callback")(callbackRequest(signed()), fakeRes() as never);
    const consumed = fake.writes("insert", STATES)[0];
    expect(consumed?.data).toMatchObject({ shopDomain: SHOP, consumedAt: expect.any(Date) });
    expect(exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("should take a live store out of service before exchanging the code that retires its credentials", async () => {
    // Greptile #134 re-review: a fail-close attempted AFTER a failure can itself
    // fail, leaving `active` on retired credentials. Suspending first means the
    // store is already out of service whatever happens after the exchange.
    const fake = scriptedDb();
    state.db = fake.db;
    let suspendedBeforeExchange = false;
    vi.mocked(exchangeAuthorizationCode).mockImplementationOnce(async () => {
      suspendedBeforeExchange = fake.writes("update", "shopify_connector_stores").some(
        (op) => op.data?.status === "reauthorization_required" && op.data?.statusReason === "reauthorization_pending",
      );
      throw new Error("stop here");
    });

    await handlerFor("/api/shopify/callback")(callbackRequest(signed()), fakeRes() as never);

    expect(suspendedBeforeExchange).toBe(true);
    const suspend = fake.writes("update", "shopify_connector_stores")[0];
    expect(suspend?.where?.params).toEqual(expect.arrayContaining([SHOP, "active"]));
  });

  it("should not exchange the code at all when the suspension cannot be written", async () => {
    // Nothing is retired until the exchange, so stopping here leaves a live
    // store truthfully active.
    state.db = scriptedDb({ update: { shopify_connector_stores: [new Error("ECONNRESET")] } }).db;
    const res = fakeRes();
    await handlerFor("/api/shopify/callback")(callbackRequest(signed()), res as never);
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(reason(res.location)).toBe("install_failed");
  });

  it("should refuse an overlapping callback for the same shop before it exchanges its code", async () => {
    // Greptile #134, fifth pass: overlapping exchanges each retire the other's
    // credentials at a moment no fence can observe. The second callback is
    // refused while the first holds the shop's lease, so its grant never
    // happens and retires nothing.
    const fake = scriptedDb({
      insert: { shopify_install_leases: [duplicateKeyError()] },
      update: { shopify_install_leases: [0] },
    });
    state.db = fake.db;
    const res = fakeRes();
    await handlerFor("/api/shopify/callback")(callbackRequest(signed()), res as never);

    expect(reason(res.location)).toBe("installation_in_progress");
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(fake.writes("update", "shopify_connector_stores")).toEqual([]); // nothing suspended either
  });

  it("should stop before the exchange when its lease was taken over while it stalled", async () => {
    // Greptile #134, sixth pass. The lease is renewed immediately before the
    // exchange; a callback that lost it must not exchange, or its grant would
    // retire the credentials of the installation that took over.
    const fake = scriptedDb({ update: { shopify_install_leases: [0] } });
    state.db = fake.db;
    const res = fakeRes();
    await handlerFor("/api/shopify/callback")(callbackRequest(signed()), res as never);

    expect(reason(res.location)).toBe("installation_in_progress");
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("should release its lease once the install ends, even when it fails", async () => {
    const fake = scriptedDb();
    state.db = fake.db;
    vi.mocked(exchangeAuthorizationCode).mockRejectedValueOnce(new Error("Shopify unreachable"));
    await handlerFor("/api/shopify/callback")(callbackRequest(signed()), fakeRes() as never);

    const taken = fake.writes("insert", "shopify_install_leases")[0]?.data?.leaseId;
    expect(taken).toBeTruthy();
    expect(fake.writes("delete", "shopify_install_leases")[0]?.where?.params).toEqual([SHOP, taken]);
  });

  it("should refuse a state that does not match the browser's flow cookie", async () => {
    state.db = scriptedDb().db;
    const res = fakeRes();
    await handlerFor("/api/shopify/callback")(callbackRequest(signed(), signed()), res as never);
    expect(reason(res.location)).toBe("security_check_failed");
  });
});

/**
 * Every onboarding refusal maps to a reason the error page can explain. A
 * refusal that collapses to "install_failed" tells a merchant whose store was
 * protected from a cross-tenant attachment only that something broke.
 */
describe("callbackReasonFor", () => {
  it.each<[ShopifyOnboardingErrorCode, string]>([
    ["OWNERSHIP_UNVERIFIED", "ownership_verification_required"],
    ["EMAIL_CONFLICT", "email_already_registered"],
    ["MISSING_CONTACT_EMAIL", "missing_contact_email"],
    ["SHOP_IDENTITY_CONFLICT", "store_identity_conflict"],
    ["WORKSPACE_CONFLICT", "store_identity_conflict"],
    ["INSTALL_LEASE_LOST", "installation_in_progress"],
    ["TOKEN_STORE_FAILED", "install_failed"],
    ["DB_UNAVAILABLE", "install_failed"],
  ])("should map %s to %s", (code, expected) => {
    expect(callbackReasonFor(new ShopifyOnboardingError("x", code))).toBe(expected);
  });

  it("should report anything else as a generic install failure", () => {
    expect(callbackReasonFor(new Error("fetch failed"))).toBe("install_failed");
    expect(callbackReasonFor("thrown string")).toBe("install_failed");
  });
});
