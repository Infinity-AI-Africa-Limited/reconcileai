import { EventEmitter } from "node:events";
import type { Request, Response, NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signature: vi.fn(), admit: vi.fn(), process: vi.fn(), gdpr: vi.fn(),
  getUser: vi.fn(), upsert: vi.fn(), seed: vi.fn(), token: vi.fn(),
  db: { marker: "synthetic-db" },
}));
vi.mock("../_core/env", () => ({ ENV: { shoplineAppSecret: "synthetic-secret" } }));
vi.mock("../_core/clientIp", () => ({ appOriginFor: () => "https://synthetic.invalid" }));
vi.mock("../connectors/shopline/auth", () => ({
  buildAuthorizationUrl: vi.fn(), verifyCallbackSignature: vi.fn(), exchangeCodeForToken: vi.fn(),
}));
vi.mock("../connectors/shopline/signature", () => ({
  verifyOAuthSignature: vi.fn(), verifyWebhookHmac: state.signature,
}));
vi.mock("../connectors/shopline/onboarding", () => ({ onboardShoplineMerchant: vi.fn() }));
vi.mock("../connectors/shopline/webhookHandler", () => ({ admitWebhook: state.admit, processAdmittedWebhook: state.process }));
vi.mock("../connectors/shopline/gdpr", () => ({ processGdprRequest: state.gdpr, verifyGdprSignature: state.signature }));
vi.mock("../connectors/shopline/apiClient", () => ({ fetchStoreMetadata: vi.fn(), registerWebhook: vi.fn() }));
vi.mock("../db", () => ({
  getDb: async () => state.db, getUserByOpenId: state.getUser, upsertUser: state.upsert,
}));
vi.mock("../prewarmDemoUser", () => ({
  DEMO_PREWARM_OPEN_ID: "synthetic-prewarm", isPrewarmComplete: () => false,
  ensureGuestDemoOrganization: async () => 42, ensureGuestDemoSeeded: state.seed,
}));
vi.mock("../_core/sdk", () => ({ sdk: { createSessionToken: state.token } }));
vi.mock("../_core/cookies", () => ({ getSessionCookieOptions: () => ({ httpOnly: true }) }));

import { createShoplineRouter } from "../connectors/shopline/routes";
import { establishGuestSession } from "../routers/authGuestSession";
import { ApplicationLifecycle, applicationLifecycle } from "./lifecycle";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
function handler(path: string): Handler {
  const stack = (createShoplineRouter() as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const route = stack.find(layer => layer.route?.path === path)?.route;
  if (!route) throw new Error("SHOPLINE route not registered");
  return route.stack[0].handle;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); }
function response() {
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, statusCode: 0, body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; res.headersSent = true; res.emit("finish"); return res; },
    cookie: vi.fn(),
  });
  return res;
}
const webhookReq = () => ({
  path: "/api/webhooks/shopline", method: "POST", body: {}, rawBody: Buffer.from("{}"),
  headers: {
    "x-shopline-hmac-sha256": "synthetic-hmac", "x-shopline-topic": "orders/paid",
    "x-shopline-webhook-id": "synthetic-receipt", "x-shopline-shop-domain": "synthetic.myshopline.com",
  },
}) as unknown as Request;

let lifecycle: ApplicationLifecycle;
beforeEach(() => {
  vi.clearAllMocks();
  lifecycle = new ApplicationLifecycle();
  vi.spyOn(applicationLifecycle, "run").mockImplementation(lifecycle.run.bind(lifecycle));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  state.signature.mockReturnValue(true);
  state.admit.mockResolvedValue({ status: "admitted", eventId: 17 });
  state.process.mockResolvedValue(undefined);
  state.gdpr.mockResolvedValue({ status: "processed" });
  state.seed.mockResolvedValue(undefined);
  state.token.mockResolvedValue("synthetic-token");
  state.upsert.mockResolvedValue(undefined);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("when SHOPLINE acknowledges a durably admitted webhook", () => {
  it("should count deferred processing before the handler settles and the immediate fires", async () => {
    const gate = deferred();
    state.process.mockReturnValue(gate.promise);
    const res = response();
    handler("/api/webhooks/shopline")(webhookReq(), res as unknown as Response, () => {});
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, eventId: 17 });
    expect(state.process).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.process).toHaveBeenCalledWith(state.db, { status: "admitted", eventId: 17 });
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", active: 1 });
    gate.resolve();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
  });

  it("should keep signature rejection unchanged and launch no processing", async () => {
    state.signature.mockReturnValue(false);
    const res = response();
    handler("/api/webhooks/shopline")(webhookReq(), res as unknown as Response, () => {});
    await flush();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid signature" });
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.process).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(0);
  });

  it("should track a GDPR factory handler until its own processing completes", async () => {
    const gate = deferred();
    state.gdpr.mockReturnValue(gate.promise);
    const res = response();
    handler("/api/shopline/gdpr/shop-data-request")(webhookReq(), res as unknown as Response, () => {});
    await flush();
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    gate.resolve();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(res.statusCode).toBe(200);
    expect(state.gdpr).toHaveBeenCalledWith(expect.objectContaining({ endpointKind: "shop_redact" }));
  });
});

describe("when guest login uses the cold-start fallback", () => {
  it("should reserve shared-tenant seeding before returning the guest session", async () => {
    const gate = deferred();
    const user = { id: 9, openId: "synthetic-guest", name: "Guest", organizationId: 42 };
    state.getUser.mockResolvedValueOnce(null).mockResolvedValueOnce(user);
    state.seed.mockReturnValue(gate.promise);
    const res = response();
    const result = await lifecycle.run("request", () => establishGuestSession({
      req: { headers: {} } as Request, res: res as unknown as Response,
    }));
    expect(result).toEqual({ success: true, user });
    expect(state.seed).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.seed).toHaveBeenCalledWith(9, 42);
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", active: 1 });
    gate.resolve();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });
});
