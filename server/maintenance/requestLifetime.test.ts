import { EventEmitter } from "node:events";
import { TRPCError } from "@trpc/server";
import type { Express, NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../drizzle/schema";

const state = vi.hoisted(() => ({
  authenticate: vi.fn(),
  audit: vi.fn(),
  storageGet: vi.fn(),
  organization: vi.fn(),
}));
vi.mock("../_core/sdk", () => ({ sdk: { authenticateRequest: state.authenticate } }));
vi.mock("../db", () => ({ createAuditLog: state.audit, getOrganizationById: state.organization }));
vi.mock("../_core/clientIp", () => ({ clientIp: () => "203.0.113.9" }));
vi.mock("../storage", () => ({
  storageGet: state.storageGet,
  orgIdFromKey: (key: string) => {
    const match = /^org\/(\d+)\//.exec(key);
    return match ? Number(match[1]) : null;
  },
}));

import { createContext } from "../_core/context";
import { registerStorageProxy } from "../_core/storageProxy";
import { ApplicationLifecycle, applicationLifecycle } from "./lifecycle";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); }

const user = { id: 7, openId: "synthetic-user", role: "user", organizationId: 5 } as unknown as User;

function storageProxyHandler(): Handler {
  let handler: Handler | undefined;
  registerStorageProxy({ get: (_path: string, registered: Handler) => { handler = registered; } } as unknown as Express);
  if (!handler) throw new Error("storage proxy route not registered");
  return handler;
}
function response() {
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    statusCode: 200,
    location: undefined as string | undefined,
    set: vi.fn(),
    status(code: number) { res.statusCode = code; return res; },
    send() { res.headersSent = true; res.emit("finish"); return res; },
    redirect(code: number, url: string) { res.statusCode = code; res.location = url; res.headersSent = true; res.emit("finish"); },
  });
  return res;
}

let lifecycle: ApplicationLifecycle;
beforeEach(() => {
  vi.clearAllMocks();
  lifecycle = new ApplicationLifecycle();
  vi.spyOn(applicationLifecycle, "run").mockImplementation(lifecycle.run.bind(lifecycle));
  state.storageGet.mockResolvedValue({ url: "https://storage.invalid/signed" });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("when a client disconnects while the storage proxy is authenticating", () => {
  it("should keep the drain open through authentication and the audit write that follows", async () => {
    const authenticated = deferred<User>();
    const audited = deferred();
    state.authenticate.mockReturnValue(authenticated.promise);
    state.audit.mockReturnValue(audited.promise);
    const res = response();
    const req = { params: { key: "org/5/exports/report.csv" }, headers: {}, path: "/manus-storage/org/5/exports/report.csv" } as unknown as Request;

    // The admission lease maintenanceAdmission holds; the client then goes away.
    const lease = lifecycle.enterRequest(() => { storageProxyHandler()(req, res as unknown as Response, () => {}); });
    expect(lifecycle.snapshot().active).toBe(2);
    lease.release();

    let drained = false;
    const drain = lifecycle.drain(1_000).then(result => { drained = true; return result; });
    await flush();
    expect(drained).toBe(false); // authentication is still writing lastSignedIn

    authenticated.resolve(user);
    await vi.waitFor(() => expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "storage_access" })));
    await vi.waitFor(() => expect(res.location).toBe("https://storage.invalid/signed"));
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", active: 1 });
    expect(drained).toBe(false); // the response is out; the audit insert is not

    audited.resolve();
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });
});

describe("when a client disconnects while its tRPC context is being created", () => {
  it("should keep the drain open until authentication settles", async () => {
    const authenticated = deferred<User>();
    state.authenticate.mockReturnValue(authenticated.promise);
    let context!: ReturnType<typeof createContext>;
    const lease = lifecycle.enterRequest(() => {
      context = createContext({ req: { headers: {} }, res: {} } as unknown as Parameters<typeof createContext>[0]);
    });
    expect(lifecycle.snapshot().active).toBe(2);
    lease.release();

    let drained = false;
    const drain = lifecycle.drain(1_000).then(result => { drained = true; return result; });
    await flush();
    expect(drained).toBe(false);

    authenticated.resolve(user);
    await expect(context).resolves.toMatchObject({ user: { id: 7 }, viewingAs: null });
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should treat a failed authentication as signed out and release its reservation", async () => {
    state.authenticate.mockRejectedValue(new Error("synthetic invalid session"));
    await expect(createContext({ req: { headers: {} }, res: {} } as unknown as Parameters<typeof createContext>[0]))
      .resolves.toMatchObject({ user: null });
    expect(lifecycle.snapshot().active).toBe(0);
  });

  it("should refuse context creation after the fence as a retryable 503, without authenticating", async () => {
    lifecycle.beginDrain();
    const error = await createContext({ req: { headers: {} }, res: {} } as unknown as Parameters<typeof createContext>[0])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("SERVICE_UNAVAILABLE");
    expect(state.authenticate).not.toHaveBeenCalled();
  });
});
