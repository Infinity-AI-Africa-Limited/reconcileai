import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  validate: vi.fn(),
  getDb: vi.fn(),
  getUser: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  values: vi.fn(),
}));
vi.mock("../routers", () => ({ appRouter: { createCaller: () => ({
  reconciliation: { list: state.list, create: state.create },
}) } }));
vi.mock("../apiIngestionService", () => ({ validateApiKey: state.validate }));
vi.mock("../db", () => ({ getDb: state.getDb, getUserById: state.getUser }));
vi.mock("../rateLimiter", () => ({
  publicApiLimiter: { check: () => ({ allowed: true }) },
  publicApiRateKey: () => "synthetic-key",
  createRateLimiter: () => ({ check: () => ({ allowed: true }) }),
}));
vi.mock("../_core/clientIp", () => ({ clientIpOrUnknown: () => "127.0.0.1" }));
vi.mock("./sandbox", () => ({ runSandboxReconciliation: () => ({ sandbox: true }) }));

import { ApplicationLifecycle, applicationLifecycle } from "../maintenance/lifecycle";
import { createApiGateway } from "./gateway";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
type Layer = { name?: string; handle: Handler; route?: { path: string; stack: Array<{ handle: Handler }> } };
function handlers() {
  const stack = (createApiGateway() as unknown as { stack: Layer[] }).stack;
  const rate = stack.findIndex(layer => layer.name === "rateLimit");
  if (rate < 0) throw new Error("gateway auth middleware not registered");
  return {
    auth: stack[rate + 1].handle,
    log: stack[rate + 2].handle,
    route(path: string) {
      const route = stack.find(layer => layer.route?.path === path)?.route;
      if (!route) throw new Error("gateway route not registered");
      return route.stack[0].handle;
    },
  };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function response() {
  const sent = { body: undefined as unknown, writes: 0 };
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    statusCode: 200,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { sent.body = body; sent.writes += 1; res.headersSent = true; return res; },
    end() { return res; },
  });
  return { res: res as unknown as Response, sent };
}
const request = () => ({
  method: "GET", path: "/reconciliation/runs", originalUrl: "/api/v1/reconciliation/runs",
  headers: { "x-api-key": "synthetic-api-key" }, body: {}, query: {},
  apiAuth: { organizationId: 42, apiKeyId: 17, userId: 9 },
}) as unknown as Request;

let lifecycle: ApplicationLifecycle;
beforeEach(() => {
  vi.clearAllMocks();
  lifecycle = new ApplicationLifecycle();
  vi.spyOn(applicationLifecycle, "run").mockImplementation(lifecycle.run.bind(lifecycle));
  state.getDb.mockResolvedValue({ insert: () => ({ values: state.values }) });
  state.values.mockResolvedValue(undefined);
  state.getUser.mockResolvedValue({ id: 9, isActive: true });
  state.validate.mockResolvedValue({ valid: true, organizationId: 42, apiKeyId: 17, userId: 9 });
  state.list.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("when the gateway admits asynchronous middleware and route work", () => {
  it("should count API-key validation until its promise completes", async () => {
    const validation = deferred<unknown>();
    state.validate.mockReturnValue(validation.promise);
    const next = vi.fn();
    const { res, sent } = response();
    handlers().auth(request(), res, next);
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    validation.resolve({ valid: true, organizationId: 42, apiKeyId: 17, userId: 9 });
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(next).toHaveBeenCalledOnce();
    expect(sent.writes).toBe(0);
  });

  it("should retain a handler that awaits its caller after the socket finished", async () => {
    const gate = deferred<unknown[]>();
    state.list.mockReturnValue(gate.promise);
    const { res, sent } = response();
    const stack = (createApiGateway() as unknown as { stack: Layer[] }).stack;
    const routes = stack.filter(layer => layer.route?.path === "/reconciliation/runs");
    routes[1].route!.stack[0].handle(request(), res, () => {});
    res.emit("finish");
    res.emit("close");
    const drain = lifecycle.drain(100);
    await flush();
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", active: 1 });
    gate.resolve([]);
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(sent.body).toEqual({ data: [], total: 0 });
    expect(sent.writes).toBe(1);
  });
});

describe("when API request logging waits for response finish", () => {
  it("should reserve before middleware returns and await exactly one complete log write", async () => {
    const write = deferred();
    state.values.mockReturnValue(write.promise);
    const { res, sent } = response();
    const next = vi.fn();
    handlers().log(request(), res, next);
    await flush();
    expect(next).toHaveBeenCalledOnce();
    expect(state.values).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    res.statusCode = 202;
    res.emit("finish");
    res.emit("close");
    res.emit("finish");
    await flush();
    expect(state.values).toHaveBeenCalledTimes(1);
    expect(state.values).toHaveBeenCalledWith({
      organizationId: 42, apiKeyId: 17, endpoint: "/api/v1/reconciliation/runs",
      method: "GET", status: "success", statusCode: 202, processingTimeMs: expect.any(Number),
    });
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", active: 1 });
    write.resolve(undefined);
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(sent.writes).toBe(0);
  });

  it("should not log an aborted response that never finished", async () => {
    const { res } = response();
    handlers().log(request(), res, () => {});
    await flush();
    const drain = lifecycle.drain(100);
    res.emit("close");
    res.emit("finish");
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(state.values).not.toHaveBeenCalled();
  });

  it("should preserve failed status logging and never rewrite the response on logging failure", async () => {
    state.values.mockRejectedValue(new Error("synthetic-log-failure"));
    const { res, sent } = response();
    res.statusCode = 403;
    handlers().log(request(), res, () => {});
    res.emit("finish");
    const drain = lifecycle.drain(100);
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(state.values).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", statusCode: 403 }));
    expect(sent.writes).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });
});
