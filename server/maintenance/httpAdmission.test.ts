import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { ApplicationLifecycle } from "./lifecycle";
import { maintenanceAdmission } from "./httpAdmission";

class FixtureResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  code: number | undefined;
  body: unknown;
  headers = new Map<string, string>();
  setHeader(name: string, value: string) { this.headers.set(name, value); }
  status(code: number) { this.code = code; return this; }
  json(body: unknown) { this.body = body; this.writableEnded = true; this.emit("finish"); return this; }
}
const req = (path: string, method = "GET") => ({ path, method }) as Request;
const next = (fn: () => void) => fn as NextFunction;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("when new HTTP traffic arrives after the process admission fence", () => {
  it.each(["/api/health", "/api/trpc/auth.me", "/api/webhooks/shopify", "/api/webhooks/email/inbound", "/api/woodcore/sync", "/api/magic-login", "/dashboard", "/api/healthz/"])("should reject %s before downstream auth, parsing or dependency work", path => {
    const lifecycle = new ApplicationLifecycle();
    lifecycle.beginDrain();
    const res = new FixtureResponse();
    const downstream = vi.fn();
    maintenanceAdmission(lifecycle)(req(path), res as unknown as Response, next(downstream));
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ code: "maintenance_unavailable" });
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(downstream).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(0);
  });
  it("should exempt only exact dependency-free GET probes", () => {
    const lifecycle = new ApplicationLifecycle();
    lifecycle.beginDrain();
    for (const path of ["/api/healthz", "/api/readyz"]) {
      const downstream = vi.fn();
      maintenanceAdmission(lifecycle)(req(path), new FixtureResponse() as unknown as Response, next(downstream));
      expect(downstream).toHaveBeenCalledOnce();
    }
    const res = new FixtureResponse();
    maintenanceAdmission(lifecycle)(req("/api/healthz", "POST"), res as unknown as Response, next(vi.fn()));
    expect(res.code).toBe(503);
  });
});

describe("when HTTP response and handler lifetimes differ", () => {
  it("should keep a real async handler tracked after its response disconnects", async () => {
    const lifecycle = new ApplicationLifecycle();
    const res = new FixtureResponse();
    let finish!: () => void;
    let handler!: Promise<void>;
    maintenanceAdmission(lifecycle)(req("/api/fixture"), res as unknown as Response, next(() => {
      handler = lifecycle.run("request", () => new Promise<void>(resolve => { finish = resolve; }));
    }));
    expect(lifecycle.snapshot().active).toBe(2);
    res.emit("close");
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(1000);
    let settled = false;
    void drain.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    finish();
    await handler;
    expect(await drain).toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });
  it("should release a synchronously completed response exactly once", async () => {
    const lifecycle = new ApplicationLifecycle();
    const res = new FixtureResponse();
    maintenanceAdmission(lifecycle)(req("/api/fixture"), res as unknown as Response, next(() => { res.json({ ok: true }); }));
    expect(lifecycle.snapshot().active).toBe(0);
    res.emit("close");
    expect(lifecycle.snapshot().active).toBe(0);
    expect((await lifecycle.drain(1000)).status).toBe("drained");
  });
  it("should release the reservation if downstream throws synchronously", () => {
    const lifecycle = new ApplicationLifecycle();
    const res = new FixtureResponse();
    const errorHandler = vi.fn((error?: unknown) => { if (!error) throw new Error("fixture_failure"); });
    maintenanceAdmission(lifecycle)(req("/api/fixture"), res as unknown as Response, errorHandler);
    expect(lifecycle.snapshot().active).toBe(0);
    expect(errorHandler).toHaveBeenLastCalledWith(expect.any(Error));
  });
});
